import { describe, expect, test } from "bun:test";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@earendil-works/pi-ai";
import { CloudCodeTransport } from "./transport.js";
import { CloudCodeClient } from "./client.js";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import type { CloudCodeModelSpec } from "./types.js";
import { sanitizeSurrogates } from "../common/protocol-sanitizer.js";
import { Http2SessionPool } from "../common/http2-pool.js";
import { StreamTransport } from "../common/stream-transport.js";

interface TokenStoreTestState {
	cachedAccessToken?: string;
	readKeychainRaw(): string | undefined;
}

interface StreamTransportTestState {
	http2Pool: {
		request(url: URL, init: RequestInit): Promise<Response>;
		close(): void;
	};
	fetchImpl(url: string, init: RequestInit): Promise<Response>;
}

interface CloudCodeClientTestState {
	transport: {
		loadProjectId(accessToken: string, signal?: AbortSignal): Promise<string>;
		postWithRetry(): Promise<Response>;
		readSse(response: Response, signal?: AbortSignal): AsyncGenerator<unknown>;
	};
}

interface CloudCodeTransportTestState {
	streamTransport: {
		postWithRetry(
			path: string,
			headers: Record<string, string>,
			body: unknown,
			options: { retryRateLimits?: boolean },
		): Promise<Response>;
	};
}

interface TokenStoreClientTestState {
	hasSession(): boolean;
	getAccessToken(): Promise<string>;
}

interface FakeSessionState {
	session: {
		ref(): void;
		unref(): void;
		close(): void;
		destroy(): void;
	};
	activeStreams: number;
	remoteLimit: number;
	closed: boolean;
}

interface Http2PoolConnectionTestState {
	createSession(origin: string): Promise<FakeSessionState>;
}

interface Http2PoolTestState {
	sessionsByOrigin: Map<string, Array<{ activeStreams: number }>>;
}

const MODEL_SPEC: CloudCodeModelSpec = {
	id: "benchmark",
	name: "Benchmark",
	backend: "benchmark",
	effort: "high",
	maxTokens: 1024,
};

describe("CloudCode performance contracts", () => {
	test("warms the configured CloudCode origin during transport initialization", async () => {
		const originalWarmConnection = StreamTransport.prototype.warmConnection;
		let warmCalls = 0;
		StreamTransport.prototype.warmConnection = async function () {
			warmCalls += 1;
		};
		try {
			new CloudCodeTransport(
				"https://daily-cloudcode-pa.googleapis.com",
				"test",
				"{}",
				{} as TokenStore,
			);
			await Promise.resolve();
			expect(warmCalls).toBe(1);
		} finally {
			StreamTransport.prototype.warmConnection = originalWarmConnection;
		}
	});

	test("routes an HTTPS request through the HTTP/2 pool without a prior warm call", async () => {
		let route = "none";
		const transport = new StreamTransport({
			host: "https://example.invalid",
			maxRetries: 0,
		});
		const state = transport as unknown as StreamTransportTestState;
		state.http2Pool = {
			request: async () => {
				route = "http2";
				return Response.json({ ok: true });
			},
			close() {},
		};
		state.fetchImpl = async () => {
			route = "fetch";
			return Response.json({ ok: true });
		};

		await transport.postWithRetry("/test", {}, {});
		expect(route).toBe("http2");
		await transport.close();
	});

	test("releases an HTTP/2 session after its response body closes", async () => {
		const server = createServer();
		server.on("stream", (stream) => {
			stream.respond({ ":status": 200, "content-type": "application/json" });
			stream.end('{"ok":true}');
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;
		const origin = `http://127.0.0.1:${address.port}`;
		const pool = new Http2SessionPool();

		const response = await pool.request(new URL(`${origin}/test`), {
			method: "GET",
		});
		expect(await response.json()).toEqual({ ok: true });
		const state = pool as unknown as Http2PoolTestState;
		expect(state.sessionsByOrigin.get(origin)?.[0]?.activeStreams).toBe(0);

		pool.close();
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
	});

	test("does not reopen the HTTP/2 pool after shutdown", async () => {
		const pool = new Http2SessionPool();
		pool.close();
		await expect(
			pool.request(new URL("https://example.invalid/test"), { method: "GET" }),
		).rejects.toThrow("HTTP/2 session pool is closed");
	});

	test("keeps shared HTTP/2 connection creation alive when one waiter aborts", async () => {
		const pool = new Http2SessionPool();
		const state = pool as unknown as Http2PoolConnectionTestState;
		const connection = Promise.withResolvers<FakeSessionState>();
		let destroyed = false;
		state.createSession = () => connection.promise;
		const firstController = new AbortController();
		const first = pool.warm("https://example.invalid", firstController.signal);
		const second = pool.warm("https://example.invalid");
		firstController.abort(new Error("first waiter cancelled"));
		connection.resolve({
			session: {
				ref() {},
				unref() {},
				close() {},
				destroy() {
					destroyed = true;
				},
			},
			activeStreams: 0,
			remoteLimit: 128,
			closed: false,
		});

		await expect(first).rejects.toThrow("first waiter cancelled");
		await expect(second).resolves.toBeUndefined();
		expect(destroyed).toBe(false);
		pool.close();
	});

	test("rejects an HTTP/2 stream that closes before response headers", async () => {
		const server = createServer();
		server.on("stream", (stream) => stream.close());
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;
		const pool = new Http2SessionPool();

		await expect(
			pool.request(new URL(`http://127.0.0.1:${address.port}/test`), {
				method: "GET",
			}),
		).rejects.toThrow("before response");

		pool.close();
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
	});

	test("uses cached tokens for session checks without synchronous storage access", () => {
		const store = new TokenStore();
		const state = store as unknown as TokenStoreTestState;
		let storageReads = 0;
		state.cachedAccessToken = "cached-access-token";
		state.readKeychainRaw = () => {
			storageReads += 1;
			return "stored-session";
		};

		expect(store.hasSession()).toBe(true);
		expect(storageReads).toBe(0);
	});

	test("uses one credential lookup and forwards cancellation to project discovery", async () => {
		const client = new CloudCodeClient();
		const tokenStore = client.getTokenStore() as unknown as TokenStoreClientTestState;
		let sessionChecks = 0;
		let tokenReads = 0;
		tokenStore.hasSession = () => {
			sessionChecks += 1;
			return true;
		};
		tokenStore.getAccessToken = async () => {
			tokenReads += 1;
			return "access-token";
		};
		const controller = new AbortController();
		let projectSignal: AbortSignal | undefined;
		const clientState = client as unknown as CloudCodeClientTestState;
		clientState.transport = {
			async loadProjectId(_accessToken, signal) {
				projectSignal = signal;
				return "project";
			},
			async postWithRetry() {
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
			async *readSse() {},
		};
		const model = {
			id: "benchmark",
			provider: "antigravity",
			api: "google-generative-ai",
			input: ["text"],
		} as unknown as Model;
		const context = { messages: [] } as unknown as Context;
		for await (const _event of client.stream(model, MODEL_SPEC, context, {
			signal: controller.signal,
		})) {}

		expect(sessionChecks).toBe(0);
		expect(tokenReads).toBe(1);
		expect(projectSignal).toBe(controller.signal);
	});

	test("makes CloudCode the only 429 retry owner and aborts its backoff", async () => {
		const originalWarmConnection = StreamTransport.prototype.warmConnection;
		StreamTransport.prototype.warmConnection = async function () {};
		const controller = new AbortController();
		const abortReason = new Error("quota wait cancelled");
		let requestCount = 0;
		let retryRateLimits: boolean | undefined;
		try {
			const transport = new CloudCodeTransport(
				"https://daily-cloudcode-pa.googleapis.com",
				"test",
				"{}",
				{} as TokenStore,
			);
			const state = transport as unknown as CloudCodeTransportTestState;
			state.streamTransport.postWithRetry = async (_path, _headers, _body, options) => {
				requestCount += 1;
				retryRateLimits = options.retryRateLimits;
				return new Response("retryable", { status: 429 });
			};
			controller.abort(abortReason);

			await expect(
				transport.postWithRetry(
					"streamGenerateContent",
					"access-token",
					{},
					controller.signal,
				),
			).rejects.toBe(abortReason);
			expect(retryRateLimits).toBe(false);
			expect(requestCount).toBe(1);
		} finally {
			StreamTransport.prototype.warmConnection = originalWarmConnection;
		}
	});

	test("maps reasoning off to a zero server-side thinking budget", () => {
		expect(
			GeminiConversationBuilder.resolveThinkingConfig(MODEL_SPEC, {
				reasoning: "off",
			}),
		).toEqual({ thinkingBudget: 0, includeThoughts: false });
		expect(
			GeminiConversationBuilder.resolveThinkingConfig(MODEL_SPEC, {
				disableReasoning: true,
			}),
		).toEqual({ thinkingBudget: 0, includeThoughts: false });
	});

	test("keeps surrogate sanitization semantics for clean, paired, and unpaired input", () => {
		expect(sanitizeSurrogates("plain text")).toBe("plain text");
		expect(sanitizeSurrogates("paired 😀 value")).toBe("paired 😀 value");
		expect(sanitizeSurrogates("bad \uD800 value \uDFFF")).toBe("bad � value �");
	});

	test("uses one sliding watchdog timer for an entire SSE stream", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let timerAllocations = 0;
		const countingSetTimeout = ((...args: Parameters<typeof setTimeout>) => {
			timerAllocations += 1;
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		Object.defineProperty(globalThis, "setTimeout", {
			configurable: true,
			value: countingSetTimeout,
			writable: true,
		});

		try {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (let n = 0; n < 32; n += 1) {
						controller.enqueue(encoder.encode(`data: {"n":${n}}\n\n`));
					}
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			const transport = new StreamTransport({ inactivityTimeoutMs: 5_000 });
			let count = 0;
			for await (const _event of transport.readSse(new Response(body))) count += 1;
			expect(count).toBe(32);
			expect(timerAllocations).toBe(1);
			await transport.close();
		} finally {
			Object.defineProperty(globalThis, "setTimeout", {
				configurable: true,
				value: originalSetTimeout,
				writable: true,
			});
		}
	});

	test("rejects a stalled SSE stream at the inactivity deadline", async () => {
		const body = new ReadableStream<Uint8Array>({
			start() {},
		});
		const transport = new StreamTransport({ inactivityTimeoutMs: 10 });
		const iterator = transport.readSse(new Response(body));
		await expect(iterator.next()).rejects.toThrow(
			"Stream stalled: no data received from provider for 0.01s",
		);
		await transport.close();
	});

	test("cancels a pending SSE read immediately when its signal aborts", async () => {
		const body = new ReadableStream<Uint8Array>({
			start() {},
		});
		const controller = new AbortController();
		const transport = new StreamTransport({ inactivityTimeoutMs: 45_000 });
		const iterator = transport.readSse(new Response(body), controller.signal);
		const pending = iterator.next();
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		await transport.close();
	});

	test("parses split and multiline SSE events in order", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('event: update\ndata: {"message":'));
				controller.enqueue(encoder.encode('"hello\\nworld"}\n\ndata: [DONE]\n\n'));
				controller.close();
			},
		});
		const transport = new StreamTransport({ inactivityTimeoutMs: 5_000 });
		const events: Array<Record<string, unknown>> = [];
		for await (const event of transport.readSse(new Response(body))) events.push(event);
		expect(events).toEqual([{ message: "hello\nworld", type: "update" }]);
		await transport.close();
	});
});
