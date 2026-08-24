import { describe, expect, test } from "bun:test";
import { CloudCodeTransport } from "./transport.js";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import type { CloudCodeModelSpec } from "./types.js";
import { sanitizeSurrogates } from "../common/protocol-sanitizer.js";
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

const FLASH_MODEL_SPEC: CloudCodeModelSpec = {
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash",
	backend: "gemini-3.7-flash",
	effort: "high",
	maxTokens: 1024,
};

const PRO_MODEL_SPEC: CloudCodeModelSpec = {
	id: "gemini-3.7-pro",
	name: "Gemini 3.7 Pro",
	backend: "gemini-3.7-pro",
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

	test("maps reasoning off to a zero server-side thinking budget for flash and omits for pro", () => {
		expect(
			GeminiConversationBuilder.resolveThinkingConfig(FLASH_MODEL_SPEC, {
				reasoning: "off",
			}),
		).toEqual({ thinkingBudget: 0, includeThoughts: false });
		expect(
			GeminiConversationBuilder.resolveThinkingConfig(PRO_MODEL_SPEC, {
				reasoning: "off",
			}),
		).toBeUndefined();
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
