import { describe, expect, test } from "bun:test";
import { ProviderQuotaStore } from "../common/quota-store.js";
import {
	fetchCodexQuota,
	formatCodexModelLabel,
	parseCodexQuotaPayload,
	resolveCodexUsageUrl,
} from "./quota.js";
import { formatTokens } from "../common/index.js";
const LIVE_SHAPE = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 76,
			limit_window_seconds: 604800,
			reset_after_seconds: 40929,
			reset_at: 1787201127,
		},
		secondary_window: null,
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			metered_feature: "codex_bengalfox",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604800,
					reset_after_seconds: 604800,
					reset_at: 1787764998,
				},
				secondary_window: null,
			},
		},
	],
};


const plainTheme = { fg: (_color: string, text: string) => text };

describe("Codex quota parsing", () => {
	test("parses the general weekly and GPT-5.3 Spark windows", async () => {
		expect(typeof parseCodexQuotaPayload).toBe("function");
		const snapshot = parseCodexQuotaPayload(LIVE_SHAPE);
		expect(snapshot).toMatchObject({
			ok: true,
			planType: "pro",
			general: { remainingPct: 24, windowSeconds: 604800, resetAt: 1787201127 },
			spark: { remainingPct: 100, windowSeconds: 604800, resetAt: 1787764998 },
		});
	});

	test("clamps percentages and tolerates a missing Spark bucket", async () => {
		expect(typeof parseCodexQuotaPayload).toBe("function");
		const snapshot = parseCodexQuotaPayload({
			rate_limit: {
				primary_window: { used_percent: 140, limit_window_seconds: 604800 },
			},
			additional_rate_limits: [],
		});
		expect(snapshot.general.remainingPct).toBe(0);
		expect(snapshot.spark).toBeUndefined();
	});

	test("resolves ChatGPT and API Codex usage URLs", async () => {
		expect(typeof resolveCodexUsageUrl).toBe("function");
		expect(resolveCodexUsageUrl("https://chatgpt.com/backend-api/codex")).toBe(
			"https://chatgpt.com/backend-api/wham/usage",
		);
		expect(resolveCodexUsageUrl("https://api.openai.com/v1")).toBe(
			"https://api.openai.com/v1/api/codex/usage",
		);
	});

	test("derives the compact active-model label", async () => {
		expect(typeof formatCodexModelLabel).toBe("function");
		expect(formatCodexModelLabel("gpt-5.6-sol")).toBe("GPT5.6");
		expect(formatCodexModelLabel("gpt-5.3-codex-spark")).toBe("GPT5.3");
		expect(formatCodexModelLabel("unknown")).toBe("Codex");
	});

	test("fetches with bearer and account headers while returning only quota data", async () => {
		expect(typeof fetchCodexQuota).toBe("function");
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
		).toString("base64url");
		const fakeToken = `header.${payload}.signature`;
		let capturedUrl = "";
		let capturedHeaders = new Headers();
		const snapshot = await fetchCodexQuota(
			{ apiKey: fakeToken, baseUrl: "https://chatgpt.com/backend-api/codex" },
			{
				fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
					capturedUrl = String(input);
					capturedHeaders = new Headers(init?.headers);
					return new Response(JSON.stringify(LIVE_SHAPE), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		);
		expect(capturedUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(capturedHeaders.get("authorization")).toBe(`Bearer ${fakeToken}`);
		expect(capturedHeaders.get("chatgpt-account-id")).toBe("acct-test");
		expect(snapshot).toMatchObject({ ok: true, general: { remainingPct: 24 }, spark: { remainingPct: 100 } });
		expect(JSON.stringify(snapshot)).not.toContain(fakeToken);
		expect(JSON.stringify(snapshot)).not.toContain("acct-test");
	});
});

describe("Quota store badge and countdown timers", () => {
	test("renders quota headroom with countdown timers and exact spacing", () => {
		const store = ProviderQuotaStore.get();
		const resetTime = new Date(Date.now() + (3 * 3600 + 45 * 60) * 1000).toISOString();
		store.updateFromAgySnapshot({
			ok: true,
			groups: [{
				name: "Gemini",
				buckets: [
					{ name: "5 hour", window: "5h", remainingFraction: 0.85, resetTime },
					{ name: "weekly", window: "weekly", remainingFraction: 0.92 },
				],
			}],
		});
		expect(store.formatBadge("antigravity", plainTheme)).toBe(
			"⚡ 5h: 85% rem (3h 45m) • 7d: 92% rem",
		);
	});

	test("respects color thresholds: Normal (≥ 20%), Amber/Warning (< 20%), Red/Exhausted (0%)", () => {
		const store = ProviderQuotaStore.get();
		const themed = {
			fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
		};
		const resetTime = new Date(Date.now() + 45 * 60 * 1000).toISOString();

		// Normal threshold: 20% (≥ 20%) -> accent
		store.updateFromAgySnapshot({
			ok: true,
			groups: [{
				name: "Gemini",
				buckets: [
					{ name: "5 hour", window: "5h", remainingFraction: 0.20, resetTime },
					{ name: "weekly", window: "weekly", remainingFraction: 0.92 },
				],
			}],
		});
		expect(store.formatBadge("antigravity", themed)).toBe(
			"[accent]⚡ 5h: 20% rem (45m) • 7d: 92% rem[/accent]",
		);

		// Warning threshold: 19% (< 20%) -> warning
		store.updateFromAgySnapshot({
			ok: true,
			groups: [{
				name: "Gemini",
				buckets: [
					{ name: "5 hour", window: "5h", remainingFraction: 0.19, resetTime },
					{ name: "weekly", window: "weekly", remainingFraction: 0.92 },
				],
			}],
		});
		expect(store.formatBadge("antigravity", themed)).toBe(
			"[warning]⚠️ 5h: 19% rem (45m) • 7d: 92% rem[/warning]",
		);

		// Exhausted threshold: 0% -> error
		store.updateFromAgySnapshot({
			ok: true,
			groups: [{
				name: "Gemini",
				buckets: [
					{ name: "5 hour", window: "5h", remainingFraction: 0.0, resetTime },
					{ name: "weekly", window: "weekly", remainingFraction: 0.92 },
				],
			}],
		});
		expect(store.formatBadge("antigravity", themed)).toBe(
			"[error]⛔ 5h: 0% rem (45m) • 7d: 92% rem[/error]",
		);
	});

	test("renders Claude unified rate limit telemetry with countdown timer", () => {
		const store = ProviderQuotaStore.get();
		const resetSec = Math.round((Date.now() + (3 * 3600 + 45 * 60) * 1000) / 1000).toString();
		store.updateFromAnthropicHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "0.15",
			"anthropic-ratelimit-unified-7d-utilization": "0.08",
			"anthropic-ratelimit-unified-5h-reset": resetSec,
			"anthropic-ratelimit-unified-5h-status": "allowed",
		});
		expect(store.formatBadge("claude", plainTheme)).toBe(
			"⚡ 5h: 85% rem (3h 45m) • 7d: 92% rem",
		);
	});

	test("renders Codex model labels with reset countdowns", () => {
		const store = ProviderQuotaStore.get();
		const resetAt = Math.round((Date.now() + 120 * 60 * 1000) / 1000);
		store.updateFromCodexSnapshot({
			ok: true,
			general: { remainingPct: 24, windowSeconds: 604800, resetAt },
			spark: { remainingPct: 100, windowSeconds: 604800, resetAt },
		});
		expect(store.formatBadge("openai-codex", plainTheme, "gpt-5.6-sol")).toBe(
			"⚡ GPT5.6 wk: 24% rem (2h) • GPT5.3: 100% rem",
		);
	});
});

describe("Context Window Token Gauge & Clean Integer Scaling", () => {
	test("formats token counts with clean integer scaling (no trailing .0)", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(1000)).toBe("1k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(45200)).toBe("45.2k");
		expect(formatTokens(250000)).toBe("250k");
		expect(formatTokens(1000000)).toBe("1M");
		expect(formatTokens(1500000)).toBe("1.5M");
		expect(formatTokens(2000000)).toBe("2M");
	});

	test("formats context window token gauge matching specification", () => {
		const renderGauge = (tokens: number, contextWindow: number) => {
			const percentValue = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
			const percent = Number.isFinite(percentValue) ? percentValue.toFixed(1) : "0.0";
			return `${formatTokens(tokens)}/${formatTokens(contextWindow)} (${percent}%)`;
		};

		expect(renderGauge(45200, 1000000)).toBe("45.2k/1M (4.5%)");
		expect(renderGauge(0, 1000000)).toBe("0/1M (0.0%)");
		expect(renderGauge(250000, 1000000)).toBe("250k/1M (25.0%)");
	});
});
