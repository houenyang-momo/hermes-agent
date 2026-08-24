import {
	type ClientHttp2Session,
	type ClientHttp2Stream,
	connect,
	constants,
	type IncomingHttpHeaders,
} from "node:http2";

export interface Http2PoolConfig {
	maxSessionsPerOrigin: number;
	maxConcurrentStreams: number;
	idleTimeoutMs: number;
	connectTimeoutMs: number;
}

interface SessionState {
	session: ClientHttp2Session;
	activeStreams: number;
	remoteLimit: number;
	closed: boolean;
	idleTimer?: NodeJS.Timeout;
}

const DEFAULT_CONFIG: Http2PoolConfig = {
	maxSessionsPerOrigin: 2,
	maxConcurrentStreams: 128,
	idleTimeoutMs: 60_000,
	connectTimeoutMs: 3_000,
};

export class Http2SessionPool {
	private readonly config: Http2PoolConfig;
	private closed = false;
	private readonly sessionsByOrigin = new Map<string, SessionState[]>();
	private readonly releaseWaitersByOrigin = new Map<string, Set<() => void>>();
	private readonly connectingByOrigin = new Map<
		string,
		Promise<SessionState>
	>();

	constructor(config: Partial<Http2PoolConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	public async warm(origin: string, signal?: AbortSignal): Promise<void> {
		await this.acquire(origin, signal).then((state) =>
			this.release(origin, state),
		);
	}

	public async request(url: URL, init: RequestInit): Promise<Response> {
		const origin = url.origin;
		const state = await this.acquire(origin, init.signal ?? undefined);
		let request: ClientHttp2Stream | undefined;
		try {
			if (init.signal?.aborted) {
				throw (
					init.signal.reason ?? new Error("HTTP/2 stream acquisition aborted")
				);
			}

			const method = (init.method ?? "GET").toUpperCase();
			if (
				init.body != null &&
				typeof init.body !== "string" &&
				!(init.body instanceof Uint8Array)
			) {
				throw new TypeError(
					"HTTP/2 stream transport only supports string or Uint8Array request bodies",
				);
			}
			const headers: Record<string, string> = {
				[constants.HTTP2_HEADER_METHOD]: method,
				[constants.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
				[constants.HTTP2_HEADER_SCHEME]: url.protocol.slice(0, -1),
				[constants.HTTP2_HEADER_AUTHORITY]: url.host,
			};
			new Headers(init.headers).forEach((value, name) => {
				const normalized = name.toLowerCase();
				if (
					normalized !== "connection" &&
					normalized !== "keep-alive" &&
					normalized !== "host"
				) {
					headers[normalized] = value;
				}
			});

			request = state.session.request(headers, {
				endStream: init.body == null,
			});
			const stream = request;
			const abortStream = () => {
				if (!stream.destroyed && !stream.closed) {
					try {
						stream.close(constants.NGHTTP2_CANCEL);
					} catch {}
				}
			};
			init.signal?.addEventListener("abort", abortStream, { once: true });
			stream.once("close", () => {
				init.signal?.removeEventListener("abort", abortStream);
				this.release(origin, state);
			});

			const response = new Promise<Response>((resolve, reject) => {
				const abortReason = () =>
					init.signal?.reason ?? new Error("HTTP/2 request aborted");
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const onAborted = () => {
					cleanup();
					reject(
						init.signal?.aborted
							? abortReason()
							: new Error("HTTP/2 stream aborted before response"),
					);
				};
				const onClose = () => {
					cleanup();
					reject(
						init.signal?.aborted
							? abortReason()
							: new Error("HTTP/2 stream closed before response"),
					);
				};
				const onAbort = () => {
					cleanup();
					reject(abortReason());
				};
				const onResponse = (incoming: IncomingHttpHeaders) => {
					cleanup();
					try {
						const status = Number(
							incoming[constants.HTTP2_HEADER_STATUS] ?? 500,
						);
						const responseHeaders = this.toResponseHeaders(incoming);
						const hasBody =
							method !== "HEAD" &&
							status !== 204 &&
							status !== 205 &&
							status !== 304;
						const body = hasBody ? this.toReadableStream(stream) : null;
						if (!hasBody) stream.resume();
						resolve(new Response(body, { status, headers: responseHeaders }));
					} catch (error) {
						reject(error);
					}
				};
				const cleanup = () => {
					stream.removeListener("error", onError);
					stream.removeListener("aborted", onAborted);
					stream.removeListener("close", onClose);
					stream.removeListener("response", onResponse);
					init.signal?.removeEventListener("abort", onAbort);
				};
				stream.once("error", onError);
				stream.once("aborted", onAborted);
				stream.once("close", onClose);
				stream.once("response", onResponse);
				init.signal?.addEventListener("abort", onAbort, { once: true });

				if (init.signal?.aborted) {
					abortStream();
					onAbort();
					return;
				}
				if (init.body != null) {
					try {
						stream.end(init.body);
					} catch (error) {
						cleanup();
						reject(error);
					}
				}
			});

			return await response;
		} catch (error) {
			if (!request) this.release(origin, state);
			else request.close(constants.NGHTTP2_CANCEL);
			throw error;
		}
	}

	public close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const states of this.sessionsByOrigin.values()) {
			for (const state of states) {
				state.closed = true;
				clearTimeout(state.idleTimer);
				state.session.close();
			}
		}
		this.sessionsByOrigin.clear();
		for (const origin of this.releaseWaitersByOrigin.keys()) {
			this.wakeAll(origin);
		}
		this.releaseWaitersByOrigin.clear();
	}

	private async acquire(
		origin: string,
		signal?: AbortSignal,
	): Promise<SessionState> {
		while (true) {
			if (this.closed) throw new Error("HTTP/2 session pool is closed");
			if (signal?.aborted) {
				throw (
					signal.reason ?? new Error("HTTP/2 stream acquisition aborted")
				);
			}
			const states = (this.sessionsByOrigin.get(origin) ?? []).filter(
				(state) => !state.closed,
			);
			if (states.length > 0) this.sessionsByOrigin.set(origin, states);
			else this.sessionsByOrigin.delete(origin);
			const available = states.find(
				(state) =>
					state.activeStreams <
					Math.min(this.config.maxConcurrentStreams, state.remoteLimit),
			);
			if (available) {
				if (available.idleTimer) clearTimeout(available.idleTimer);
				available.idleTimer = undefined;
				if (available.activeStreams === 0) available.session.ref();
				available.activeStreams += 1;
				return available;
			}
			if (states.length < this.config.maxSessionsPerOrigin) {
				const connecting =
					this.connectingByOrigin.get(origin) ??
					this.startSessionCreation(origin);
				await this.awaitConnection(connecting, signal);
				continue;
			}
			await this.waitForRelease(origin, signal);
		}
	}

	private startSessionCreation(origin: string): Promise<SessionState> {
		const connecting = this.createSession(origin).then((created) => {
			if (this.closed) {
				created.closed = true;
				created.session.destroy();
				throw new Error("HTTP/2 session pool is closed");
			}
			const current = this.sessionsByOrigin.get(origin) ?? [];
			if (!current.includes(created)) current.push(created);
			this.sessionsByOrigin.set(origin, current);
			this.wakeAll(origin);
			return created;
		});
		this.connectingByOrigin.set(origin, connecting);
		const clearConnecting = () => {
			if (this.connectingByOrigin.get(origin) === connecting)
				this.connectingByOrigin.delete(origin);
		};
		void connecting.then(clearConnecting, clearConnecting);
		return connecting;
	}

	private awaitConnection(
		connecting: Promise<SessionState>,
		signal?: AbortSignal,
	): Promise<SessionState> {
		if (!signal) return connecting;
		if (signal.aborted) {
			return Promise.reject(
				signal.reason ?? new Error("HTTP/2 stream acquisition aborted"),
			);
		}
		return new Promise<SessionState>((resolve, reject) => {
			const onAbort = () => {
				reject(
					signal.reason ?? new Error("HTTP/2 stream acquisition aborted"),
				);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void connecting.then(
				(state) => {
					signal.removeEventListener("abort", onAbort);
					resolve(state);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private createSession(origin: string): Promise<SessionState> {
		const { promise, resolve, reject } = Promise.withResolvers<SessionState>();
		const session = connect(origin, {
			settings: { enablePush: false },
		});
		let timer: NodeJS.Timeout;
		const cleanupConnectListeners = () => {
			clearTimeout(timer);
			session.removeListener("error", onConnectionError);
			session.removeListener("connect", onConnect);
		};
		const onConnectionError = (error: Error) => {
			cleanupConnectListeners();
			reject(error);
		};
		const onConnect = () => {
			cleanupConnectListeners();
			if (
				origin.startsWith("https:") &&
				"alpnProtocol" in session.socket &&
				session.socket.alpnProtocol !== "h2"
			) {
				session.destroy();
				reject(new Error(`Origin ${origin} did not negotiate HTTP/2`));
				return;
			}
			session.unref();
			const state: SessionState = {
				session,
				activeStreams: 0,
				remoteLimit: this.config.maxConcurrentStreams,
				closed: false,
			};
			session.on("remoteSettings", (settings) => {
				if (typeof settings.maxConcurrentStreams === "number") {
					state.remoteLimit = Math.max(1, settings.maxConcurrentStreams);
				}
			});
			session.on("error", () => {
				state.closed = true;
				this.removeSession(origin, state);
				this.wakeAll(origin);
			});
			session.once("close", () => {
				state.closed = true;
				this.removeSession(origin, state);
				this.wakeAll(origin);
			});
			resolve(state);
		};
		timer = setTimeout(() => {
			cleanupConnectListeners();
			session.destroy();
			reject(new Error(`HTTP/2 connection to ${origin} timed out`));
		}, this.config.connectTimeoutMs);
		timer.unref();
		session.once("error", onConnectionError);
		session.once("connect", onConnect);
		return promise;
	}

	private release(origin: string, state: SessionState): void {
		state.activeStreams = Math.max(0, state.activeStreams - 1);
		if (state.activeStreams === 0 && !state.closed) {
			state.session.unref();
			state.idleTimer = setTimeout(() => {
				state.closed = true;
				state.session.close();
			}, this.config.idleTimeoutMs);
			state.idleTimer.unref();
		}
		this.wakeOne(origin);
	}

	private waitForRelease(origin: string, signal?: AbortSignal): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiters =
			this.releaseWaitersByOrigin.get(origin) ?? new Set<() => void>();
		this.releaseWaitersByOrigin.set(origin, waiters);
		const wake = () => {
			cleanup();
			resolve();
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new Error("HTTP/2 stream acquisition aborted"));
		};
		const cleanup = () => {
			waiters.delete(wake);
			if (
				waiters.size === 0 &&
				this.releaseWaitersByOrigin.get(origin) === waiters
			) {
				this.releaseWaitersByOrigin.delete(origin);
			}
			signal?.removeEventListener("abort", onAbort);
		};
		waiters.add(wake);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	private wakeOne(origin: string): void {
		const waiters = this.releaseWaitersByOrigin.get(origin);
		const wake = waiters?.values().next().value;
		wake?.();
	}

	private wakeAll(origin: string): void {
		const waiters = this.releaseWaitersByOrigin.get(origin);
		if (!waiters) return;
		for (const wake of [...waiters]) wake();
	}

	private removeSession(origin: string, state: SessionState): void {
		const states = this.sessionsByOrigin.get(origin);
		if (!states) return;
		const remaining = states.filter((candidate) => candidate !== state);
		if (remaining.length > 0) this.sessionsByOrigin.set(origin, remaining);
		else this.sessionsByOrigin.delete(origin);
	}

	private toResponseHeaders(incoming: IncomingHttpHeaders): Headers {
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming)) {
			if (name.startsWith(":")) continue;
			if (Array.isArray(value)) {
				for (const item of value) headers.append(name, item);
			} else if (value !== undefined) {
				headers.set(name, String(value));
			}
		}
		return headers;
	}

	private toReadableStream(
		stream: ClientHttp2Stream,
	): ReadableStream<Uint8Array> {
		let isClosed = false;
		let onData: ((chunk: Uint8Array) => void) | undefined;
		let onEnd: (() => void) | undefined;
		let onClose: (() => void) | undefined;
		let onError: ((error: Error) => void) | undefined;
		const cleanupStream = () => {
			if (isClosed) return;
			isClosed = true;
			if (onData) stream.removeListener("data", onData);
			if (onEnd) stream.removeListener("end", onEnd);
			if (onClose) stream.removeListener("close", onClose);
			if (onError) stream.removeListener("error", onError);
		};
		return new ReadableStream<Uint8Array>({
			start(controller) {
				const closeController = () => {
					if (isClosed) return;
					cleanupStream();
					try {
						controller.close();
					} catch {}
				};
				onData = (chunk: Uint8Array) => {
					if (isClosed) return;
					try {
						controller.enqueue(chunk);
						if (controller.desiredSize !== null && controller.desiredSize <= 0) {
							stream.pause();
						}
					} catch {
						cleanupStream();
					}
				};
				onEnd = closeController;
				onClose = closeController;
				onError = (error: Error) => {
					if (isClosed) return;
					cleanupStream();
					try {
						controller.error(error);
					} catch {}
				};
				stream.on("data", onData);
				stream.once("end", onEnd);
				stream.once("close", onClose);
				stream.on("error", onError);
			},
			pull() {
				if (!isClosed) stream.resume();
			},
			cancel() {
				cleanupStream();
				if (!stream.destroyed && !stream.closed) {
					try {
						stream.close(constants.NGHTTP2_CANCEL);
					} catch {}
				}
			},
		});
	}
}
