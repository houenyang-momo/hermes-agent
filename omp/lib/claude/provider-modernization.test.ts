import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import { TokenStore } from "./token-store.js";
import type { ClaudeModelSpec } from "./types.js";

class TestEventStream implements AsyncIterable<AssistantMessageEvent> {
	private events: AssistantMessageEvent[] = [];
	private wakeReaders: Array<() => void> = [];
	private ended = false;

	public push(event: AssistantMessageEvent): void {
		this.events.push(event);
		this.wakeReaders.shift()?.();
	}

	public end(): void {
		this.ended = true;
		for (const wake of this.wakeReaders.splice(0)) wake();
	}

	public async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		while (true) {
			const event = this.events.shift();
			if (event) {
				yield event;
				continue;
			}
			if (this.ended) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.wakeReaders.push(resolve);
			await promise;
		}
	}
}

mock.module("@earendil-works/pi-ai", () => ({
	createAssistantMessageEventStream: () => new TestEventStream(),
	streamSimple: () => new TestEventStream(),
}));

mock.module("@earendil-works/pi-ai/api/openai-codex-responses", () => ({
	streamSimple: () => new TestEventStream(),
}));

mock.module("../cloudcode/client.js", () => ({
	CloudCodeClient: class {
		getTokenStore() {
			return { hasSession: () => false };
		}
	},
}));

// Dynamic import is intentional: Bun must install the runtime mocks before client.ts evaluates.
const { ClaudeClient } = await import("./client.js");
const tempDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
	for (const directory of tempDirectories)
		rmSync(directory, { recursive: true, force: true });
});

function createAuthFixture(entries: Array<Record<string, unknown>>): string {
	const root = mkdtempSync(join(tmpdir(), "claude-token-pool-"));
	tempDirectories.push(root);
	const authPath = join(root, "auth.json");
	mkdirSync(root, { recursive: true });
	writeFileSync(authPath, JSON.stringify({ anthropic: entries }));
	return authPath;
}

async function* createFallbackStream(): AsyncGenerator<AssistantMessageEvent> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "recovered by Sol" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: {
			input: 1,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	yield { type: "start", partial: message };
	yield { type: "done", reason: "stop", message };
}

describe("Claude multi-account token pool", () => {
	test("discovers primary and secondary OAuth profiles and rotates across them", async () => {
		const expires = Date.now() + 60 * 60_000;
		const authPath = createAuthFixture([
			{
				type: "oauth",
				access: "primary-access",
				refresh: "primary-refresh",
				expires,
				accountId: "primary",
			},
			{
				type: "oauth",
				access: "secondary-access",
				refresh: "secondary-refresh",
				expires,
				accountId: "secondary",
			},
		]);
		const store = new TokenStore(undefined, undefined, {
			authFilePath: authPath,
			claudeCredentialsFilePath: join(
				tmpdir(),
				"missing-claude-credentials.json",
			),
			keychainServices: () => [],
			env: {},
		});

		const tokens = await Promise.all(
			Array.from({ length: 16 }, () => store.getAuth()),
		);
		expect(store.getPoolSize()).toBe(2);
		expect(new Set(tokens.map((auth) => auth.token))).toEqual(
			new Set(["primary-access", "secondary-access"]),
		);
	});

	test("single-flights refresh per profile without globally locking other profiles", async () => {
		const authPath = createAuthFixture([
			{
				type: "oauth",
				access: "expired-a",
				refresh: "refresh-a",
				expires: 1,
				accountId: "a",
			},
			{
				type: "oauth",
				access: "expired-b",
				refresh: "refresh-b",
				expires: 1,
				accountId: "b",
			},
		]);
		const refreshCalls = new Map<string, number>();
		const store = new TokenStore(undefined, undefined, {
			authFilePath: authPath,
			claudeCredentialsFilePath: join(
				tmpdir(),
				"missing-claude-credentials.json",
			),
			keychainServices: () => [],
			env: {},
			refreshOAuthToken: async (refreshToken: string) => {
				refreshCalls.set(
					refreshToken,
					(refreshCalls.get(refreshToken) ?? 0) + 1,
				);
				await Promise.resolve();
				return {
					access_token: `fresh-${refreshToken}`,
					refresh_token: refreshToken,
					expires_at: Date.now() + 60 * 60_000,
				};
			},
		});

		const health = await store.healthCheck();
		expect(health.every((profile) => profile.healthy)).toBe(true);
		expect(refreshCalls).toEqual(
			new Map([
				["refresh-a", 1],
				["refresh-b", 1],
			]),
		);
	});
});

describe("Claude to Sol Ultra spillover", () => {
	test("bridges a rate_limit_exceeded response into the active turn", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (request.method === "HEAD")
					return new Response(null, { status: 204 });
				return Response.json(
					{
						error: {
							type: "rate_limit_exceeded",
							message: "rate_limit_exceeded",
						},
					},
					{ status: 429, headers: { "retry-after": "60" } },
				);
			},
		});
		servers.push(server);
		let fallbackCalls = 0;
		const client = new ClaudeClient({
			host: `http://127.0.0.1:${server.port}`,
			oauthToken: "test-claude-token",
			fallbackStreamFactory: () => {
				fallbackCalls += 1;
				return createFallbackStream();
			},
		});
		const spec: ClaudeModelSpec = {
			id: "claude-opus-5",
			name: "Claude Opus 5",
			backend: "claude-opus-5",
			effort: "high",
			maxTokens: 128_000,
			contextWindow: 1_000_000,
		};
		const model: Model = {
			id: spec.id,
			name: spec.name,
			api: "anthropic-messages",
			provider: "oauth",
			contextWindow: spec.contextWindow,
			maxTokens: spec.maxTokens,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const events = [];
		for await (const event of client.stream(model, spec, context, {}))
			events.push(event);

		expect(fallbackCalls).toBe(1);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		const done = events.find((event) => event.type === "done");
		expect(done?.type === "done" ? done.message.provider : undefined).toBe(
			"openai-codex",
		);
		expect(done?.type === "done" ? done.message.model : undefined).toBe(
			"gpt-5.6-sol",
		);
	});
});
