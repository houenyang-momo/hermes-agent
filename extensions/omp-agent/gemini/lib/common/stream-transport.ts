import { Http2SessionPool } from "./http2-pool.js";
import { isRecord } from "./value-guards.js";

/**
 * Unified Stream Transport Engine for Pi Agent Provider Extensions.
 *
 * Provides a hardened, zero-dependency, zero-subprocess HTTP/2 keep-alive transport with:
 * - Sliding inactivity watchdog timer (default: 45s) to eliminate streaming stalls
 * - Cancellable exponential backoff with jitter on 429/5xx and Retry-After header parsing
 * - Automatic 401 token invalidation & single retry hook
 * - Clean async generator SSE parser yielding validated JSON payloads or typed SSE chunks
 */

export interface StreamTransportConfig {
	host?: string;
	defaultHeaders?: Record<string, string>;
	inactivityTimeoutMs?: number;
	requestTimeoutMs?: number;
	maxRetries?: number;
	maxConnections?: number;
	maxConcurrentStreams?: number;
	keepAliveTimeoutMs?: number;
	fetchImpl?: StreamFetch;
}

export interface PostRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	attempt?: number;
	retryRateLimits?: boolean;
	authRetried?: boolean;
	on401Retry?: () => Promise<Record<string, string>>;
}
export type StreamFetch = (url: string, init: RequestInit) => Promise<Response>;

export function cancellableDelay(
	delayMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve(true);
	}, delayMs);

	function onAbort() {
		clearTimeout(timer);
		resolve(false);
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

export function parseRetryAfterMs(
	value: string | null,
	now = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const dateMs = Date.parse(value);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.max(0, dateMs - now);
}

export class StreamTransport {
	private host: string;
	private defaultHeaders: Record<string, string>;
	private inactivityTimeoutMs: number;
	private requestTimeoutMs: number;
	private maxRetries: number;
	private http2Pool?: Http2SessionPool;
	private fetchImpl: StreamFetch;

	constructor(config: StreamTransportConfig = {}) {
		this.host = config.host ? config.host.replace(/\/+$/, "") : "";
		this.defaultHeaders = config.defaultHeaders || {};
		this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? 45_000;
		this.requestTimeoutMs = config.requestTimeoutMs ?? 120_000;
		this.maxRetries = config.maxRetries ?? 3;
		this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
		if (!config.fetchImpl) {
			const maxConcurrentStreams = config.maxConcurrentStreams ?? 128;
			this.http2Pool = new Http2SessionPool({
				maxSessionsPerOrigin: Math.max(
					1,
					Math.ceil((config.maxConnections ?? 64) / maxConcurrentStreams),
				),
				maxConcurrentStreams,
				idleTimeoutMs: config.keepAliveTimeoutMs ?? 60_000,
				connectTimeoutMs: 3_000,
			});
		}
	}

	public async warmConnection(path = ""): Promise<void> {
		if (!this.host) return;
		try {
			const targetUrl = new URL(
				path.startsWith("http://") || path.startsWith("https://")
					? path
					: `${this.host}/${path.replace(/^\/+/, "")}`,
			);
			if (targetUrl.protocol === "https:" && this.http2Pool) {
				await this.http2Pool.warm(targetUrl.origin, AbortSignal.timeout(3000));
				return;
			}
			await this.fetchImpl(targetUrl.href, {
				method: "HEAD",
				headers: this.defaultHeaders,
				signal: AbortSignal.timeout(3000),
			}).catch(() => {});
		} catch {}
	}

	public async close(): Promise<void> {
		this.http2Pool?.close();
		this.http2Pool = undefined;
	}

	public createTimeoutSignal(
		ms: number,
		parentSignal?: AbortSignal,
	): { signal: AbortSignal; cleanup: () => void } {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error(`Request timed out after ${ms}ms`)),
			ms,
		);

		const onParentAbort = () => {
			clearTimeout(timer);
			controller.abort(
				parentSignal?.reason ?? new Error("Parent request aborted"),
			);
		};

		if (parentSignal) {
			if (parentSignal.aborted) {
				clearTimeout(timer);
				controller.abort(parentSignal.reason);
			} else {
				parentSignal.addEventListener("abort", onParentAbort, { once: true });
			}
		}

		return {
			signal: controller.signal,
			cleanup: () => {
				clearTimeout(timer);
				if (parentSignal) {
					parentSignal.removeEventListener("abort", onParentAbort);
				}
			},
		};
	}

	public async postWithRetry(
		pathOrUrl: string,
		headers: Record<string, string>,
		body: unknown,
		options: PostRequestOptions = {},
	): Promise<Response> {
		const attempt = options.attempt ?? 0;
		const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
		const signal = options.signal;

		const { signal: timeoutSignal, cleanup } = this.createTimeoutSignal(
			timeoutMs,
			signal,
		);
		let response: Response;

		const targetUrl =
			pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
				? pathOrUrl
				: `${this.host}/${pathOrUrl.replace(/^\/+/, "")}`;

		const mergedHeaders: Record<string, string> = {
			...this.defaultHeaders,
			...headers,
		};
		for (const name of Object.keys(mergedHeaders)) {
			const normalized = name.toLowerCase();
			if (normalized === "connection" || normalized === "keep-alive")
				delete mergedHeaders[name];
		}
		try {
			const requestInit: RequestInit = {
				method: "POST",
				headers: mergedHeaders,
				body: typeof body === "string" ? body : JSON.stringify(body),
				signal: timeoutSignal,
			};
			const target = new URL(targetUrl);
			response =
				this.http2Pool && target.protocol === "https:"
					? await this.http2Pool.request(target, requestInit)
					: await this.fetchImpl(targetUrl, requestInit);
		} catch (err: unknown) {
			cleanup();
			if (
				attempt < this.maxRetries &&
				(err as Error)?.name !== "AbortError" &&
				!signal?.aborted
			) {
				const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 4000);
				const proceed = await cancellableDelay(delay, signal);
				if (proceed) {
					return this.postWithRetry(pathOrUrl, headers, body, {
						...options,
						attempt: attempt + 1,
					});
				}
			}
			throw err;
		}
		cleanup();

		// Transient error retries. Provider quota handlers can own 429 retries while
		// overload responses and the remaining transient statuses stay transport-owned.
		const isTransient =
			(response.status === 429 && options.retryRateLimits !== false) ||
			response.status === 529 ||
			[408, 409, 500, 502, 503, 504].includes(response.status);
		if (isTransient && attempt < this.maxRetries && !signal?.aborted) {
			const retryHeaderMs = parseRetryAfterMs(
				response.headers.get("retry-after"),
			);
			const delay =
				retryHeaderMs !== undefined && retryHeaderMs <= 10_000
					? retryHeaderMs
					: Math.min(1000 * 2 ** attempt + Math.random() * 500, 6000);
			await response.body?.cancel().catch(() => undefined);
			const proceed = await cancellableDelay(delay, signal);
			if (proceed) {
				return this.postWithRetry(pathOrUrl, headers, body, {
					...options,
					attempt: attempt + 1,
				});
			}
		}

		// Single 401/403 auth failure token invalidation & refresh retry
		if (
			(response.status === 401 || response.status === 403) &&
			!options.authRetried &&
			options.on401Retry &&
			!signal?.aborted
		) {
			let freshHeaders: Record<string, string> | undefined;
			try {
				freshHeaders = await options.on401Retry();
			} catch {
				// Return original response if refresh hook fails
			}
			if (freshHeaders) {
				await response.body?.cancel().catch(() => undefined);
				return this.postWithRetry(pathOrUrl, freshHeaders, body, {
					...options,
					authRetried: true,
				});
			}
		}

		return response;
	}

	public async *readSse<
		T extends Record<string, unknown> = Record<string, unknown>,
	>(
		response: Response,
		signal?: AbortSignal,
		inactivityTimeoutMs?: number,
	): AsyncGenerator<T> {
		if (!response.body) throw new Error("Streaming response had no body");
		const timeoutMs = inactivityTimeoutMs ?? this.inactivityTimeoutMs;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let cursor = 0;
		let currentEvent = "";
		let dataBuffer = "";
		let readPending = false;
		let watchdogError: Error | undefined;
		const watchdog = setTimeout(() => {
			if (!readPending) return;
			watchdogError = new Error(
				`Stream stalled: no data received from provider for ${timeoutMs / 1000}s`,
			);
			void reader.cancel(watchdogError).catch(() => undefined);
		}, timeoutMs);
		watchdog.unref();
		let abortError: Error | undefined;
		const onAbort = () => {
			abortError = signal?.reason instanceof Error
				? signal.reason
				: new Error("Request was aborted");
			void reader.cancel(abortError).catch(() => undefined);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		try {
			while (true) {
				if (abortError) throw abortError;

				readPending = true;
				watchdog.refresh();
				const result = await reader.read();
				readPending = false;
				if (abortError) throw abortError;
				if (watchdogError) throw watchdogError;

				const { done, value } = result;
				if (done) break;

				buf += decoder.decode(value, { stream: true });
				let nl = buf.indexOf("\n", cursor);

				while (nl >= 0) {
					const lineEnd = nl > cursor && buf.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
					const line = buf.slice(cursor, lineEnd);
					cursor = nl + 1;

					if (line.startsWith("event:")) {
						currentEvent = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						const payload = line.startsWith("data: ")
							? line.slice(6)
							: line.slice(5);
						dataBuffer = dataBuffer ? `${dataBuffer}\n${payload}` : payload;
					} else if (line === "") {
						if (dataBuffer) {
							const rawPayload = dataBuffer;
							const evt = currentEvent;
							dataBuffer = "";
							currentEvent = "";

							if (rawPayload === "[DONE]") {
								return;
							}

							try {
								const parsed: unknown = JSON.parse(rawPayload);
								if (isRecord(parsed)) {
									if (evt && typeof parsed.type !== "string") parsed.type = evt;
									// SSE payload shape is provider-specific; callers bind T at their typed transport seam.
									yield parsed as T;
								}
							} catch {
								// Ignore keepalive heartbeats or comments
							}
						}
					}
					nl = buf.indexOf("\n", cursor);
				}

				if (cursor > 0) {
					buf = cursor === buf.length ? "" : buf.slice(cursor);
					cursor = 0;
				}
			}
		} finally {
			clearTimeout(watchdog);
			signal?.removeEventListener("abort", onAbort);
			try {
				await reader.cancel();
			} catch {
				// Clean exit
			}
		}
	}
}
