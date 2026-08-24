import { performance } from "node:perf_hooks";
import { CloudCodeTransport } from "./transport.js";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import { sanitizeSurrogates } from "../common/protocol-sanitizer.js";
import { StreamTransport } from "../common/stream-transport.js";
import type { CloudCodeModelSpec } from "./types.js";

interface TokenStoreBenchmarkState {
	cachedAccessToken?: string;
	cachedTokenExpiryMs: number;
}

interface StreamTransportBenchmarkState {
	http2Pool: {
		request(url: URL, init: RequestInit): Promise<Response>;
		close(): void;
	};
	fetchImpl(url: string, init: RequestInit): Promise<Response>;
}

async function benchmark(name: string, run: () => void | Promise<void>) {
	const started = performance.now();
	await run();
	return { name, durationMs: Number((performance.now() - started).toFixed(3)) };
}

const results: Record<string, unknown> = {};

const previousAccessToken = process.env.CLOUDCODE_ACCESS_TOKEN;
const previousAntigravityToken = process.env.ANTIGRAVITY_TOKEN;
delete process.env.CLOUDCODE_ACCESS_TOKEN;
delete process.env.ANTIGRAVITY_TOKEN;
try {
	const store = new TokenStore();
	const state = store as unknown as TokenStoreBenchmarkState;
	state.cachedAccessToken = "benchmark-token";
	state.cachedTokenExpiryMs = Date.now() + 3_600_000;
	results.sessionFastPath = await benchmark("TokenStore.hasSession x10000", () => {
		for (let i = 0; i < 10_000; i += 1) {
			if (!store.hasSession()) throw new Error("expected active session");
		}
	});
} finally {
	if (previousAccessToken === undefined) delete process.env.CLOUDCODE_ACCESS_TOKEN;
	else process.env.CLOUDCODE_ACCESS_TOKEN = previousAccessToken;
	if (previousAntigravityToken === undefined) delete process.env.ANTIGRAVITY_TOKEN;
	else process.env.ANTIGRAVITY_TOKEN = previousAntigravityToken;
}

const cleanText = "clean ascii and bmp text ".repeat(256);
results.surrogateFastPath = await benchmark("sanitizeSurrogates clean x100000", () => {
	let value = "";
	for (let i = 0; i < 100_000; i += 1) value = sanitizeSurrogates(cleanText);
	if (value !== cleanText) throw new Error("clean text changed");
});

const eventCount = 10_000;
const payload = Array.from({ length: eventCount }, (_, n) => `data: {"n":${n}}\n\n`).join("") + "data: [DONE]\n\n";
results.cursorParser = await benchmark(`readSse ${eventCount} events in one chunk`, async () => {
	const transport = new StreamTransport({ inactivityTimeoutMs: 5_000 });
	let count = 0;
	const response = new Response(new TextEncoder().encode(payload));
	for await (const event of transport.readSse(response)) {
		if (event.n !== count) throw new Error(`event order mismatch at ${count}`);
		count += 1;
	}
	if (count !== eventCount) throw new Error(`expected ${eventCount} events, got ${count}`);
	await transport.close();
});

const originalSetTimeout = globalThis.setTimeout;
let watchdogTimerAllocations = 0;
const countingSetTimeout = ((...args: Parameters<typeof setTimeout>) => {
	watchdogTimerAllocations += 1;
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
			for (let n = 0; n < 256; n += 1) {
				controller.enqueue(encoder.encode(`data: {"n":${n}}\n\n`));
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	const transport = new StreamTransport({ inactivityTimeoutMs: 5_000 });
	let count = 0;
	for await (const _event of transport.readSse(new Response(body))) count += 1;
	if (count !== 256) throw new Error(`expected 256 watchdog events, got ${count}`);
	await transport.close();
} finally {
	Object.defineProperty(globalThis, "setTimeout", {
		configurable: true,
		value: originalSetTimeout,
		writable: true,
	});
}
results.watchdog = { chunks: 257, timerAllocations: watchdogTimerAllocations };

let requestRoute = "none";
const routeTransport = new StreamTransport({ host: "https://example.invalid", maxRetries: 0 });
const routeState = routeTransport as unknown as StreamTransportBenchmarkState;
routeState.http2Pool = {
	request: async () => {
		requestRoute = "http2";
		return Response.json({ ok: true });
	},
	close() {},
};
routeState.fetchImpl = async () => {
	requestRoute = "fetch";
	return Response.json({ ok: true });
};
await routeTransport.postWithRetry("/benchmark", {}, {});
await routeTransport.close();
results.onDemandHttp2Route = requestRoute;

const originalWarmConnection = StreamTransport.prototype.warmConnection;
let warmCalls = 0;
StreamTransport.prototype.warmConnection = async function () {
	warmCalls += 1;
};
try {
	new CloudCodeTransport(
		"https://daily-cloudcode-pa.googleapis.com",
		"benchmark",
		"{}",
		{} as TokenStore,
	);
} finally {
	StreamTransport.prototype.warmConnection = originalWarmConnection;
}
results.cloudCodeInitializationWarmCalls = warmCalls;
const benchmarkSpec: CloudCodeModelSpec = {
	id: "benchmark",
	name: "Benchmark",
	backend: "benchmark",
	effort: "high",
	maxTokens: 1024,
};
results.reasoningOff = GeminiConversationBuilder.resolveThinkingConfig(
	benchmarkSpec,
	{ reasoning: "off" },
);

console.log(JSON.stringify(results, null, 2));
