import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { Http2SessionPool } from "./http2-pool.js";
import { ProviderQuotaStore } from "./quota-store.js";
import { StreamTransport } from "./stream-transport.js";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("provider quota failover telemetry", () => {
	test("records failover counts and a source-provider cooldown", () => {
		const store = ProviderQuotaStore.get();
		const before =
			store.getFailoverMetrics("claude", "openai-codex")?.count ?? 0;
		const metric = store.recordFailover({
			sourceProvider: "claude",
			targetProvider: "openai-codex",
			targetModel: "gpt-5.6-sol",
			reason: "rate_limit_exceeded",
			status: 429,
			cooldownMs: 60_000,
		});

		expect(metric.count).toBe(before + 1);
		expect(metric.cooldownUntil).toBeGreaterThan(Date.now());
		expect(store.isCoolingDown("claude")).toBe(true);
		expect(store.getQuota("claude")?.isExhausted).toBe(true);
	});
});

describe("high-concurrency stream transport", () => {
	test("runs at least sixteen simulated subagent requests without serialization", async () => {
		let active = 0;
		let releaseRequests: (() => void) | undefined;
		let reportAllArrived: (() => void) | undefined;
		const release = new Promise<void>((resolve) => {
			releaseRequests = resolve;
		});
		const allArrived = new Promise<void>((resolve) => {
			reportAllArrived = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "HEAD")
					return new Response(null, { status: 204 });
				active += 1;
				if (active === 16) reportAllArrived?.();
				await release;
				active -= 1;
				return Response.json({ ok: true });
			},
		});
		servers.push(server);
		const transport = new StreamTransport({
			host: `http://127.0.0.1:${server.port}`,
			maxRetries: 0,
			maxConnections: 64,
			maxConcurrentStreams: 128,
		});

		const pending = Array.from({ length: 16 }, (_, index) =>
			transport.postWithRetry("/stream", {}, { index }),
		);
		await allArrived;
		releaseRequests?.();
		const responses = await Promise.all(pending);
		expect(responses.every((response) => response.ok)).toBe(true);
		await transport.close();
	});

	test("multiplexes sixteen requests over one HTTP/2 session", async () => {
		const server = createServer();
		let sessionCount = 0;
		server.on("session", () => {
			sessionCount += 1;
		});
		server.on("stream", (stream) => {
			stream.respond({ ":status": 200, "content-type": "application/json" });
			stream.end('{"ok":true}');
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;
		const pool = new Http2SessionPool({
			maxSessionsPerOrigin: 2,
			maxConcurrentStreams: 128,
			idleTimeoutMs: 60_000,
			connectTimeoutMs: 3_000,
		});
		const responses = await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				pool.request(new URL(`http://127.0.0.1:${address.port}/stream`), {
					method: "POST",
					body: JSON.stringify({ index }),
				}),
			),
		);
		expect(responses.every((response) => response.ok)).toBe(true);
		expect(
			await Promise.all(responses.map((response) => response.json())),
		).toHaveLength(16);
		expect(sessionCount).toBe(1);
		pool.close();
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
	});

	test("uses a sliding inactivity watchdog while chunks continue", async () => {
		// This integration test exercises the real reader watchdog; fake timers cannot drive ReadableStream scheduling.
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(encoder.encode('data: {"type":"tick","n":1}\n\n'));
				await Bun.sleep(15);
				controller.enqueue(encoder.encode('data: {"type":"tick","n":2}\n\n'));
				await Bun.sleep(15);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		const transport = new StreamTransport({
			inactivityTimeoutMs: 25,
			maxRetries: 0,
		});
		const events: Array<Record<string, unknown>> = [];
		for await (const event of transport.readSse(new Response(body)))
			events.push(event);
		expect(events.map((event) => event.n)).toEqual([1, 2]);
		await transport.close();
	});

	test("survives unexpected HTTP/2 session errors post-connection without uncaught exception", async () => {
		const server = createServer((_, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;

		const pool = new Http2SessionPool({
			maxSessionsPerOrigin: 2,
			maxConcurrentStreams: 128,
			idleTimeoutMs: 60_000,
			connectTimeoutMs: 3_000,
		});

		// 1. Initial request establishes session
		const res1 = await pool.request(new URL(`http://127.0.0.1:${address.port}/`), {
			method: "GET",
		});
		expect(res1.ok).toBe(true);

		// 2. Abruptly destroy server to simulate network / remote RST/GOAWAY error
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;

		// 3. Pool close should clean up gracefully without unhandled errors
		expect(() => pool.close()).not.toThrow();
	});

	test("handles stream cancellation and reader.cancel() without secondary errors", async () => {
		const server = createServer((_, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('data: {"chunk": 1}\n\n');
			// Intentionally hold open
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as AddressInfo;

		const pool = new Http2SessionPool();
		const response = await pool.request(new URL(`http://127.0.0.1:${address.port}/`), {
			method: "GET",
		});

		const transport = new StreamTransport({ inactivityTimeoutMs: 10_000 });
		const iterator = transport.readSse(response);
		const first = await iterator.next();
		expect(first.value).toEqual({ chunk: 1 });

		// Cancelling the iterator / reader should cleanly close HTTP2 stream
		await iterator.return();

		pool.close();
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
	});
});
