/**
 * Claude Provider Extension for Pi Agent.
 *
 * Provides native, zero-stall, ultra-low-latency streaming for:
 * - (oAuth) Claude Opus 5
 * - (oAuth) Claude Opus 4.8
 * - (oAuth) Claude Sonnet 5
 * - (oAuth) Claude Sonnet 4.6
 * - (oAuth) Claude Haiku 4.5
 *
 * Supports Dual-Seam Authentication:
 * 1. Claude Code Enterprise OAuth Session
 * 2. Direct ANTHROPIC_API_KEY environment variable fallback
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ClaudeClient, fetchClaudeQuota, formatClaudeQuotaSnapshot, type ClaudeModelSpec } from "../lib/claude/index.js";
import { ProviderQuotaStore } from "../lib/common/quota-store.js";

const PREFERRED_MODEL_ID = "claude-opus-5";
const ANTHROPIC_OVERFLOW_PATTERN = /prompt is too long|exceeds the maximum context length|max_tokens exceeds|context length exceeded|prompt exceeds model context window/i;

export const CLAUDE_MODELS: ClaudeModelSpec[] = [
	{
		id: "claude-fable-5",
		name: "(oAuth) Claude Fable 5",
		backend: "claude-fable-5",
		effort: "max",
		thinkingBudgetTokens: 64000,
		maxTokens: 128000,
		contextWindow: 1000000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-opus-5",
		name: "(oAuth) Claude Opus 5",
		backend: "claude-opus-5",
		effort: "max",
		thinkingBudgetTokens: 64000,
		maxTokens: 128000,
		contextWindow: 1000000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-opus-4-8",
		name: "(oAuth) Claude Opus 4.8",
		backend: "claude-opus-4-8",
		effort: "max",
		thinkingBudgetTokens: 64000,
		maxTokens: 128000,
		contextWindow: 1000000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-opus-4-6",
		name: "(oAuth) Claude Opus 4.6",
		backend: "claude-opus-4-6",
		effort: "high",
		thinkingBudgetTokens: 64000,
		maxTokens: 128000,
		contextWindow: 1000000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-sonnet-5",
		name: "(oAuth) Claude Sonnet 5",
		backend: "claude-sonnet-5",
		effort: "max",
		thinkingBudgetTokens: 64000,
		maxTokens: 128000,
		contextWindow: 1000000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-sonnet-4-6",
		name: "(oAuth) Claude Sonnet 4.6",
		backend: "claude-sonnet-4-6",
		effort: "high",
		thinkingBudgetTokens: 16384,
		maxTokens: 128000,
		contextWindow: 200000,
		supportsAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsEffort: true,
	},
	{
		id: "claude-haiku-4-5",
		name: "(oAuth) Claude Haiku 4.5",
		backend: "claude-haiku-4-5-20251001",
		effort: "off",
		thinkingBudgetTokens: 0,
		maxTokens: 64000,
		contextWindow: 200000,
		supportsAdaptiveThinking: false,
		supportsStrictTools: true,
		supportsEffort: false,
	},
];

function modelById(id: string): ClaudeModelSpec | undefined {
	return CLAUDE_MODELS.find((m) => m.id === id);
}

export default async function claudeExtension(pi: ExtensionAPI) {
	const client = new ClaudeClient();

	const providerConfig = {
		name: "Claude (OAuth)",
		baseUrl: "https://api.anthropic.com",
		apiKey: "claude-auth",
		api: "claude-custom",
		streamSimple: (model: any, context: any, options: any) => {
			const spec = modelById(model.id);
			if (!spec) throw new Error(`Unknown Claude model: ${model.id}`);
			return client.stream(model, spec, context, options);
		},
		models: CLAUDE_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.supportsAdaptiveThinking || (m.thinkingBudgetTokens ?? 0) > 0,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			thinkingLevelMap: m.supportsAdaptiveThinking || (m.thinkingBudgetTokens ?? 0) > 0
				? {
					off: null,          // Claude thinking models have no "off"
					minimal: "low",     // 1. low
					low: "medium",      // 2. medium
					medium: "high",     // 3. high
					high: "xhigh",      // 4. xhigh
					xhigh: "max",       // 5. max
					max: "ultracode",   // 6. ultracode
				}
				: {
					off: "off",
					minimal: null,
					low: null,
					medium: null,
					high: null,
					xhigh: null,
					max: null,
				},
		})),
	};

	// Register under primary "oauth" (so status bar shows `(oAuth)`) and override built-in "anthropic"
	pi.registerProvider("oauth", providerConfig);
	pi.registerProvider("anthropic", {
		...providerConfig,
		name: "Anthropic (OAuth)",
	});

	// Normalize context overflow errors for Pi automatic compaction
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		const prov = message.provider || ctx.model?.provider;
		if (prov !== "oauth" && prov !== "claude" && prov !== "anthropic") return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!ANTHROPIC_OVERFLOW_PATTERN.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});

	const handleCommand = async (args: string, ctx: any, prefix: string) => {
		const sub = (args || "").trim().split(/\s+/)[0] || "status";

		if (sub === "models") {
			const lines = CLAUDE_MODELS.map((m) => {
				const mark = m.id === PREFERRED_MODEL_ID ? "  <- default pick" : "";
				return `  ${m.id} (${m.name})\n    backend: ${m.backend} | default effort: ${m.effort} | maxTokens: ${m.maxTokens}${mark}`;
			}).join("\n");
			ctx.ui.notify(`Claude OAuth Models (Native Stream):\n${lines}`, "info");
			return;
		}

		if (sub === "quota" || sub === "usage") {
			ctx.ui.notify("Fetching live Claude quota telemetry…", "info");
			const snapshot = await fetchClaudeQuota();
			ctx.ui.notify(formatClaudeQuotaSnapshot(snapshot), snapshot.ok ? "info" : "warn");
			return;
		}

		if (sub === "auth" || sub === "status") {
			const status = await client.getStatus(PREFERRED_MODEL_ID);
			if (!status.connected) {
				ctx.ui.notify(
					`Claude Auth: NOT logged in (${status.error ?? "No active session"}).\nRun \`claude auth login\` in a terminal, then /reload.`,
					"warn",
				);
				return;
			}
			const remainingStr = status.tokenRemainingMinutes !== undefined
				? ` (${status.tokenRemainingMinutes}m until auto-refresh)`
				: "";

			const q = ProviderQuotaStore.get().getQuota("claude");
			const quotaInfo = q?.ok
				? `\n• Live Quota: 5h:${q.fiveHourRemainingPct}% remaining • 7d:${q.weeklyRemainingPct}% remaining`
				: "";

			ctx.ui.notify(
				`Claude Connected (Zero-Subprocess Native Stream):\n` +
				`• Provider: (oAuth)\n` +
				`• Auth Mode: ${status.authMode.toUpperCase()}${remainingStr}\n` +
				`• Preferred Model: ${PREFERRED_MODEL_ID} (128k output, 1M context)\n` +
				`• Reasoning Engine: Adaptive thinking with Shift+Tab effort control\n` +
				`• Caching: 4-Tier Ephemeral Prompt Caching Enabled (1-hour TTL)\n` +
				`• Plan: EBU Claude Enterprise ($0 API Cost)${quotaInfo}`,
				"info",
			);
			return;
		}

		if (sub === "login") {
			ctx.ui.notify("To sign in, run `claude auth login` in any terminal pane and authorize with EBU Claude, then /reload.", "info");
			return;
		}

		ctx.ui.notify(`Usage: /${prefix} <status|models|quota|usage|auth|login>`, "info");
	};

	pi.registerCommand("oauth", {
		description: "Claude OAuth commands: status | models | quota | auth | login",
		handler: async (args, ctx) => handleCommand(args, ctx, "oauth"),
	});

	pi.registerCommand("claude", {
		description: "Claude OAuth commands: status | models | quota | auth | login",
		handler: async (args, ctx) => handleCommand(args, ctx, "claude"),
	});
}
