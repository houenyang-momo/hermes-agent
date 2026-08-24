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
			const method = (init.method ?? "GET").toUpperCase();
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
			const abort = () => stream.close(constants.NGHTTP2_CANCEL);
			init.signal?.addEventListener("abort", abort, { once: true });
			stream.once("close", () => {
				init.signal?.removeEventListener("abort", abort);
				this.release(origin, state);
			});

			const response = new Promise<Response>((resolve, reject) => {
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const onResponse = (incoming: IncomingHttpHeaders) => {
					cleanup();
					const status = Number(incoming[constants.HTTP2_HEADER_STATUS] ?? 500);
					const responseHeaders = this.toResponseHeaders(incoming);
					const hasBody =
						method !== "HEAD" &&
						status !== 204 &&
						status !== 205 &&
						status !== 304;
					const body = hasBody ? this.toReadableStream(stream) : null;
					if (!hasBody) stream.resume();
					resolve(new Response(body, { status, headers: responseHeaders }));
				};
				const cleanup = () => {
					stream.removeListener("error", onError);
					stream.removeListener("response", onResponse);
				};
				stream.once("error", onError);
				stream.once("response", onResponse);
			});

			if (init.body != null) {
				if (
					typeof init.body !== "string" &&
					!(init.body instanceof Uint8Array)
				) {
					throw new TypeError(
						"HTTP/2 stream transport only supports string or Uint8Array request bodies",
					);
				}
				stream.end(init.body);
			}
			return await response;
		} catch (error) {
			if (!request) this.release(origin, state);
			else request.close(constants.NGHTTP2_CANCEL);
			throw error;
		}
	}

	public close(): void {
		for (const states of this.sessionsByOrigin.values()) {
			for (const state of states) {
				state.closed = true;
				clearTimeout(state.idleTimer);
				state.session.close();
			}
		}
		this.sessionsByOrigin.clear();
		for (const waiters of this.releaseWaitersByOrigin.values()) {
			for (const wake of waiters) wake();
		}
		this.releaseWaitersByOrigin.clear();
	}

	private async acquire(
		origin: string,
		signal?: AbortSignal,
	): Promise<SessionState> {
		while (true) {
			const states = (this.sessionsByOrigin.get(origin) ?? []).filter(
				(state) => !state.closed,
			);
			this.sessionsByOrigin.set(origin, states);
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
				let connecting = this.connectingByOrigin.get(origin);
				if (!connecting) {
					connecting = this.createSession(origin, signal);
					this.connectingByOrigin.set(origin, connecting);
				}
				try {
					const created = await connecting;
					const current = this.sessionsByOrigin.get(origin) ?? [];
					if (!current.includes(created)) current.push(created);
					this.sessionsByOrigin.set(origin, current);
				} finally {
					if (this.connectingByOrigin.get(origin) === connecting)
						this.connectingByOrigin.delete(origin);
				}
				continue;
			}
			await this.waitForRelease(origin, signal);
		}
	}

	private createSession(
		origin: string,
		signal?: AbortSignal,
	): Promise<SessionState> {
		const { promise, resolve, reject } = Promise.withResolvers<SessionState>();
		const session = connect(origin, {
			settings: { enablePush: false },
		});
		const timer = setTimeout(() => {
			session.destroy();
			reject(new Error(`HTTP/2 connection to ${origin} timed out`));
		}, this.config.connectTimeoutMs);
		timer.unref();
		const onAbort = () => {
			session.destroy();
			reject(signal?.reason ?? new Error("HTTP/2 connection aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			onAbort();
			return promise;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		session.once("error", (error) => {
			cleanup();
			reject(error);
		});
		session.once("connect", () => {
			cleanup();
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
				this.wakeOne(origin);
			});
			session.once("close", () => {
				state.closed = true;
				this.wakeOne(origin);
			});
			resolve(state);
		});
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
