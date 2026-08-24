/**
 * Claude provider latency diagnostic.
 *
 * Answers the two questions that actually matter when Claude "feels slow":
 *   1. Is the extension code adding latency, or is it upstream?
 *      Interleaved A/B (raw transport vs full ClaudeClient) under identical
 *      network and quota conditions, reported as medians.
 *   2. Am I being silently served by something other than Claude?
 *      client.ts treats 429/529 as quota exhaustion and streams from
 *      gpt-5.6-sol instead, with no user-visible signal. This reads
 *      ProviderQuotaStore to surface that.
 *
 * Run: bun lib/claude/diagnose-latency.ts [model-id]
 */
import { TokenStore } from "./token-store.js";
import { ClaudeTransport } from "./transport.js";
import { ClaudeConversationBuilder } from "./conversation-builder.js";
import { ClaudeClient } from "./client.js";
import { ProviderQuotaStore } from "../common/quota-store.js";
import { CLAUDE_MODELS } from "../../extensions/claude.js";
import type { Context, Model } from "@earendil-works/pi-ai";

const HOST = "https://api.anthropic.com";
const PROMPT = "Reply with exactly the word: ready";
const ROUNDS = 4;

function ms(t: number): string {
	return Number.isFinite(t) ? `${t.toFixed(0)}ms` : "n/a";
}

function delay(msWait: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, msWait);
	return promise;
}

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

function ctx(): Context {
	return {
		systemPrompt: "You are a terse assistant.",
		messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
		tools: [],
	} as unknown as Context;
}

function resolveModel(id: string) {
	const spec = CLAUDE_MODELS.find((m) => m.id === id);
	if (!spec) {
		throw new Error(
			`unknown model "${id}". known: ${CLAUDE_MODELS.map((m) => m.id).join(", ")}`,
		);
	}
	const model = {
		id: spec.id,
		provider: "oauth",
		api: "anthropic-messages",
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	} as unknown as Model;
	return { model, spec };
}

const modelId = process.argv[2] || "claude-opus-5";
const { model, spec } = resolveModel(modelId);

// Shared instances: neither path pays repeated construction cost.
const store = new TokenStore();
const transport = new ClaudeTransport(HOST, undefined, store);
const client = new ClaudeClient();

/** Bar A: extension transport only (no client orchestration). */
async function rawTtft(): Promise<number | undefined> {
	const auth = await store.getAuth();
	const envelope = ClaudeConversationBuilder.buildEnvelope(
		model,
		spec,
		ctx(),
		undefined,
		auth.mode as "oauth" | "api-key",
		store.getMetadata("diagnose", auth),
	);
	const start = performance.now();
	const res = await transport.postWithRetry(
		auth.mode === "oauth" ? "/v1/messages?beta=true" : "/v1/messages",
		auth,
		envelope,
		undefined,
		0,
		"diagnose",
	);
	if (!res.ok) {
		const status = res.status;
		const retryAfter = res.headers.get("retry-after") ?? "-";
		await res.text();
		console.log(`    raw: HTTP ${status} (retry-after=${retryAfter})`);
		return undefined;
	}
	let ttft: number | undefined;
	for await (const ev of transport.readSse(res)) {
		const e = ev as { type?: string };
		if (e.type === "content_block_delta" && ttft === undefined) {
			ttft = performance.now() - start;
		}
	}
	return ttft;
}

/** Bar B: full ClaudeClient.stream() path, same first-content-delta yardstick. */
async function clientTtft(): Promise<{ ttft?: number; provider?: string }> {
	const start = performance.now();
	let ttft: number | undefined;
	let provider: string | undefined;
	for await (const event of client.stream(model, spec, ctx())) {
		const e = event as {
			type: string;
			partial?: { provider?: string };
		};
		if (
			(e.type === "text_delta" || e.type === "thinking_delta") &&
			ttft === undefined
		) {
			ttft = performance.now() - start;
		}
		if (e.partial?.provider) provider = e.partial.provider;
	}
	return { ttft, provider };
}

async function main() {
	const quotaStore = ProviderQuotaStore.get();
	const beforeFailover =
		quotaStore.getFailoverMetrics("claude", "openai-codex")?.count ?? 0;

	console.log(
		`=== Claude latency diagnostic: ${modelId} (${ROUNDS} interleaved rounds) ===\n`,
	);
	console.log(
		`  effort "${spec.effort}" resolves to ${JSON.stringify(
			ClaudeConversationBuilder.resolveThinkingConfig(spec),
		)}\n`,
	);

	const raws: number[] = [];
	const clients: number[] = [];
	const providers = new Set<string>();

	for (let i = 1; i <= ROUNDS; i++) {
		// Alternate which path goes first: the second call of a round would
		// otherwise hit Anthropic's prompt cache warmed by the first, biasing
		// whichever path runs second by several hundred ms.
		const rawFirst = i % 2 === 1;
		let r: number | undefined;
		let c: { ttft?: number; provider?: string };
		if (rawFirst) {
			r = await rawTtft();
			await delay(400);
			c = await clientTtft();
		} else {
			c = await clientTtft();
			await delay(400);
			r = await rawTtft();
		}
		await delay(400);
		if (r !== undefined) raws.push(r);
		if (c.ttft !== undefined) clients.push(c.ttft);
		if (c.provider) providers.add(c.provider);
		console.log(
			`  round ${i} (${rawFirst ? "raw first " : "client first"}): raw ${ms(
				r ?? Number.NaN,
			).padStart(7)} | client ${ms(c.ttft ?? Number.NaN).padStart(7)} | delta ${
				r !== undefined && c.ttft !== undefined ? ms(c.ttft - r) : "n/a"
			}`,
		);
	}

	if (raws.length === 0 || clients.length === 0) {
		console.log(
			"\n  Not enough successful samples to compare. Check auth and quota above.",
		);
		return;
	}

	const rawMed = median(raws);
	const cliMed = median(clients);
	const rawSpread = Math.max(...raws) - Math.min(...raws);
	const overhead = cliMed - rawMed;

	console.log(`\n=== Verdict ===\n`);
	console.log(
		`  raw transport median: ${ms(rawMed)} (min ${ms(Math.min(...raws))} max ${ms(Math.max(...raws))})`,
	);
	console.log(
		`  full client median:   ${ms(cliMed)} (min ${ms(Math.min(...clients))} max ${ms(Math.max(...clients))})`,
	);
	console.log(`  extension overhead:   ${ms(overhead)}`);
	console.log(`  upstream spread:      ${ms(rawSpread)} on identical raw calls`);

	if (Math.abs(overhead) < rawSpread / 2) {
		console.log(
			`\n  → Extension code is NOT the bottleneck: overhead (${ms(
				Math.abs(overhead),
			)}) is inside upstream noise (${ms(rawSpread)}). Latency is upstream.`,
		);
	} else {
		console.log(
			`\n  → Extension adds ${ms(overhead)} beyond the raw transport. Investigate client.ts orchestration.`,
		);
	}

	const afterFailover =
		quotaStore.getFailoverMetrics("claude", "openai-codex")?.count ?? 0;
	if (afterFailover > beforeFailover) {
		const m = quotaStore.getFailoverMetrics("claude", "openai-codex");
		console.log(
			`\n  ⚠ SILENT FAILOVER during this run → ${m?.targetProvider}/${m?.targetModel} (reason=${m?.reason}).`,
		);
		console.log(
			"    Answers were served by a different model with no user-visible signal.",
		);
	} else {
		console.log(
			`\n  No failover recorded. Answers came from Claude (provider=${[...providers].join(",") || "unknown"}).`,
		);
	}

	const q = quotaStore.getQuota("claude") as Record<string, unknown> | undefined;
	if (q) {
		console.log(
			`\n  quota: 5h=${q.fiveHourRemainingPct}% weekly=${q.weeklyRemainingPct}% overage=${q.overageStatus} resetMin=${q.resetMinutes}`,
		);
		if (typeof q.weeklyRemainingPct === "number" && q.weeklyRemainingPct < 15) {
			console.log(
				"    ⚠ Weekly budget nearly exhausted — upstream throttling and 429 failover are expected.",
			);
		}
	} else {
		console.log("\n  quota: no rate-limit headers captured this run");
	}
}

main().catch((err) => {
	console.error("diagnostic failed:", err?.stack || err?.message || err);
	process.exit(1);
});
