/**
 * Antigravity provider extension for Pi.
 *
 * Declarative registration adapter backed by the deep CloudCodeClient module.
 * No subprocesses. No Gemini API keys.
 */

import type { UsageLimit, UsageReport } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CloudCodeClient, fetchAgyQuota, formatQuotaSnapshot, type CloudCodeModelSpec } from "../lib/cloudcode/index.js";
import { fetchClaudeQuota } from "../lib/claude/index.js";
import { fetchCodexQuota, formatCodexQuotaSnapshot, type CodexQuotaSnapshot } from "../lib/codex/quota.js";
import { ProviderQuotaStore, formatTokens } from "../lib/common/index.js";
export { formatTokens };

const PREFERRED_MODEL_ID = "gemini-3.7-flash";
const PREFERRED_BACKEND = "gemini-3.7-flash-tiered";
const CLOUDCODE_OVERFLOW_PATTERN = /exceeds the maximum|token count|context.*length|payload size exceeds|input is too long/i;


function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

export const GEMINI_MODELS: CloudCodeModelSpec[] = [
	{
		id: "gemini-3.7-flash",
		name: "(oAuth) Gemini 3.7 Flash",
		backend: PREFERRED_BACKEND,
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.7-flash-high",
		name: "(oAuth) Gemini 3.7 Flash (High)",
		backend: PREFERRED_BACKEND,
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.7-flash-medium",
		name: "(oAuth) Gemini 3.7 Flash (Medium)",
		backend: PREFERRED_BACKEND,
		effort: "medium",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.7-flash-low",
		name: "(oAuth) Gemini 3.7 Flash (Low)",
		backend: PREFERRED_BACKEND,
		effort: "low",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash",
		name: "(oAuth) Gemini 3.6 Flash",
		backend: "gemini-3.6-flash-high",
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash-high",
		name: "(oAuth) Gemini 3.6 Flash (High)",
		backend: "gemini-3.6-flash-high",
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash",
		name: "(oAuth) Gemini 3.5 Flash",
		backend: "gemini-3.5-flash-high",
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash-high",
		name: "(oAuth) Gemini 3.5 Flash (High)",
		backend: "gemini-3.5-flash-high",
		effort: "high",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash-medium",
		name: "(oAuth) Gemini 3.5 Flash (Medium)",
		backend: "gemini-3.5-flash-medium",
		effort: "medium",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash-low",
		name: "(oAuth) Gemini 3.5 Flash (Low)",
		backend: "gemini-3.5-flash-low",
		effort: "low",
		maxTokens: 65536,
	},
	{
		id: "gemini-3.1-pro",
		name: "(oAuth) Gemini 3.1 Pro",
		backend: "gemini-3.1-pro-low",
		effort: "high",
		maxTokens: 8192,
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "(oAuth) Gemini 3.1 Flash Lite",
		backend: "gemini-3.1-flash-lite",
		effort: "low",
		maxTokens: 8192,
	},
	{
		id: "gemini-2.5-flash",
		name: "(oAuth) Gemini 2.5 Flash",
		backend: "gemini-2.5-flash",
		effort: "low",
		maxTokens: 8192,
	},
];

function modelById(id: string): CloudCodeModelSpec | undefined {
	const exact = GEMINI_MODELS.find((m) => m.id === id);
	if (exact) return exact;
	// Suffix fallback: e.g. "gemini-3.7-flash-high" -> find "gemini-3.7-flash"
	const baseId = id.replace(/-(high|medium|low|thinking|off)$/, "");
	const base = GEMINI_MODELS.find((m) => m.id === baseId);
	if (base) {
		const effort = id.endsWith("-low") ? "low" : (id.endsWith("-medium") ? "medium" : "high");
		return { ...base, id, effort: effort as "high" | "medium" | "low" };
	}
	return undefined;
}

export default async function antigravityExtension(pi: ExtensionAPI) {
	const client = new CloudCodeClient();

	pi.registerProvider("antigravity", {
		name: "Antigravity (Google OAuth)",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		apiKey: "agy-oauth",
		api: "antigravity-custom",
		streamSimple: (model, context, options) => {
			const spec = modelById(model.id);
			if (!spec) throw new Error(`Unknown Antigravity model: ${model.id}`);
			return client.stream(model, spec, context, options);
		},
		models: GEMINI_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: m.maxTokens,
			thinkingLevelMap: {
				off: "off",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "high",
				max: "high",
			},
		})),
	});

	// ── Clean Minimal Footer with Live Quota & (oAuth) Indicator ─────────────
	const lastQuotaFetchByProvider = new Map<string, number>();

	async function fetchCodexQuotaForContext(ctx: ExtensionContext, timeoutMs = 6_000): Promise<CodexQuotaSnapshot> {
		const model = ctx.model?.provider === "openai-codex"
			? ctx.model
			: ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === "openai-codex");
		if (!model) {
			return { ok: false, fetchedAt: Date.now(), error: "No OpenAI Codex model is available" };
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			return { ok: false, fetchedAt: Date.now(), error: "OpenAI Codex OAuth is not available" };
		}
		return fetchCodexQuota({
			apiKey: auth.apiKey,
			baseUrl: auth.baseUrl ?? model.baseUrl,
			headers: auth.headers,
		}, { timeoutMs });
	}

	async function refreshQuotaSnapshot(ctx: ExtensionContext, tui?: { requestRender(): void }) {
		const prov = ctx.model?.provider || "antigravity";
		const now = Date.now();
		if (now - (lastQuotaFetchByProvider.get(prov) ?? 0) < 45_000) return;
		lastQuotaFetchByProvider.set(prov, now);

		try {
			const isClaude = prov === "oauth" || prov === "claude" || prov === "anthropic";
			if (isClaude) {
				const snapshot = await fetchClaudeQuota(6_000);
				if (snapshot.ok) {
					tui?.requestRender();
				} else {
					lastQuotaFetchByProvider.set(prov, now - 40_000); // Retry sooner on failure
				}
				return;
			}
			if (prov === "openai-codex") {
				const snapshot = await fetchCodexQuotaForContext(ctx, 6_000);
				if (snapshot.ok) {
					ProviderQuotaStore.get().updateFromCodexSnapshot(snapshot);
					tui?.requestRender();
				} else {
					lastQuotaFetchByProvider.set(prov, now - 40_000);
				}
				return;
			}
			if (prov === "antigravity" || prov === "google") {
				const snapshot = await fetchAgyQuota(12_000);
				if (snapshot.ok) {
					ProviderQuotaStore.get().updateFromAgySnapshot(snapshot);
					tui?.requestRender();
				} else {
					lastQuotaFetchByProvider.set(prov, now - 40_000);
				}
			}
		} catch {
			// Quota telemetry must never interrupt the active model.
			lastQuotaFetchByProvider.set(prov, now - 40_000);
		}
	}


	interface HookableAuthStorage {
		__agyQuotaHookInstalled?: boolean;
		fetchUsageReports?: (options?: unknown) => Promise<UsageReport[] | null | undefined>;
	}

	function hookUsageReporting(ctx: ExtensionContext) {
		const authStorage = (ctx.modelRegistry as unknown as { authStorage?: HookableAuthStorage } | undefined)?.authStorage;
		if (authStorage && !authStorage.__agyQuotaHookInstalled) {
			authStorage.__agyQuotaHookInstalled = true;
			const origFetchUsageReports = authStorage.fetchUsageReports?.bind(authStorage);

			authStorage.fetchUsageReports = async function (options?: unknown): Promise<UsageReport[]> {
				let reports: UsageReport[] = [];
				if (origFetchUsageReports) {
					try {
						reports = (await origFetchUsageReports(options)) || [];
					} catch {
						reports = [];
					}
				}

				try {
					const snapshot = await fetchAgyQuota(8_000);
					if (snapshot.ok && snapshot.groups?.length) {
						ProviderQuotaStore.get().updateFromAgySnapshot(snapshot);
						const gemini =
							snapshot.groups.find((g) => /gemini/i.test(g.name)) ?? snapshot.groups[0];
						const fh = gemini?.buckets.find(
							(b) => /5.*hour/i.test(b.name) || b.window === "5h",
						);
						const wk = gemini?.buckets.find(
							(b) => /week/i.test(b.name) || b.window === "weekly",
						);
						const now = Date.now();
						const limits: UsageLimit[] = [];
						if (fh) {
							const rem = fh.remainingFraction ?? 1;
							const resetsAt = fh.resetTime ? Date.parse(fh.resetTime) : now + 18_000_000;
							limits.push({
								id: "antigravity:5h",
								label: "5 Hour Limit",
								scope: { provider: "antigravity", windowId: "5h" },
								window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt },
								amount: {
									usedFraction: Math.max(0, Math.min(1, 1 - rem)),
									remainingFraction: rem,
									unit: "percent",
								},
							});
						}
						if (wk) {
							const rem = wk.remainingFraction ?? 1;
							const resetsAt = wk.resetTime ? Date.parse(wk.resetTime) : now + 604_800_000;
							limits.push({
								id: "antigravity:7d",
								label: "Weekly Limit",
								scope: { provider: "antigravity", windowId: "7d" },
								window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt },
								amount: {
									usedFraction: Math.max(0, Math.min(1, 1 - rem)),
									remainingFraction: rem,
									unit: "percent",
								},
							});
						}
						if (limits.length > 0) {
							for (const prov of ["antigravity", "google-antigravity", "google"]) {
								reports = reports.filter((r) => r.provider !== prov);
								reports.push({
									provider: prov,
									fetchedAt: now,
									limits,
								});
							}
						}
					}
				} catch {
					const cached = ProviderQuotaStore.get().getQuota("antigravity");
					if (cached && cached.ok) {
						const now = Date.now();
						const fhPct = cached.fiveHourRemainingPct ?? 100;
						const wkPct = cached.weeklyRemainingPct ?? 100;
						const limits: UsageLimit[] = [
							{
								id: "antigravity:5h",
								label: "5 Hour Limit",
								scope: { provider: "antigravity", windowId: "5h" },
								window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: now + (cached.resetMinutes ?? 0) * 60_000 },
								amount: {
									usedFraction: Math.max(0, Math.min(1, 1 - fhPct / 100)),
									remainingFraction: fhPct / 100,
									unit: "percent",
								},
							},
							{
								id: "antigravity:7d",
								label: "Weekly Limit",
								scope: { provider: "antigravity", windowId: "7d" },
								window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: cached.weeklyResetSec ? cached.weeklyResetSec * 1000 : now + 604_800_000 },
								amount: {
									usedFraction: Math.max(0, Math.min(1, 1 - wkPct / 100)),
									remainingFraction: wkPct / 100,
									unit: "percent",
								},
							},
						];
						for (const prov of ["antigravity", "google-antigravity", "google"]) {
							reports = reports.filter((r) => r.provider !== prov);
							reports.push({
								provider: prov,
								fetchedAt: cached.lastUpdated || now,
								limits,
							});
						}
					}
				}

				// Map Claude aliases and add remaining fraction for the status line
				const anthropicReports = reports.filter((r) => r.provider === "anthropic" || r.provider === "oauth" || r.provider === "claude");
				for (const ar of anthropicReports) {
					const mappedLimits = (ar.limits || []).map((lim) => {
						const uFrac = lim.amount?.usedFraction;
						if (typeof uFrac === "number") {
							const remFrac = Math.max(0, Math.min(1, 1 - uFrac));
							return {
								...lim,
								amount: {
									...lim.amount,
									remainingFraction: remFrac,
								},
							};
						}
						return lim;
					});
					const mappedReport = { ...ar, limits: mappedLimits };
					reports = reports.filter((r) => r.provider !== "oauth" && r.provider !== "claude" && r.provider !== "anthropic");
					reports.push({ ...mappedReport, provider: "anthropic" });
					reports.push({ ...mappedReport, provider: "oauth" });
					reports.push({ ...mappedReport, provider: "claude" });
				}

				// Map Codex aliases and add remaining fraction for the status line
				const codexReports = reports.filter((r) => r.provider === "openai-codex" || r.provider === "codex" || r.provider === "openai");
				for (const cr of codexReports) {
					const mappedLimits = (cr.limits || []).map((lim) => {
						const uFrac = lim.amount?.usedFraction;
						if (typeof uFrac === "number") {
							const remFrac = Math.max(0, Math.min(1, 1 - uFrac));
							return {
								...lim,
								amount: {
									...lim.amount,
									remainingFraction: remFrac,
								},
							};
						}
						return lim;
					});
					const mappedReport = { ...cr, limits: mappedLimits };
					reports = reports.filter((r) => r.provider !== "codex" && r.provider !== "openai" && r.provider !== "openai-codex");
					reports.push({ ...mappedReport, provider: "openai-codex" });
					reports.push({ ...mappedReport, provider: "codex" });
					reports.push({ ...mappedReport, provider: "openai" });
				}
				return reports;
			};
		}
	}

	function installCleanFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			void refreshQuotaSnapshot(ctx, tui);

			return {
				dispose() {
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					void refreshQuotaSnapshot(ctx, tui);

					const prov = ctx.model?.provider;

					// Line 1: Directory + Branch + Session
					let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// Line 2 Left: Live Quota + Context Percentage & Window Size ONLY
					const leftParts: string[] = [];

					// 1. Unified Live Quota Badge (reactive for Claude, Gemini, Codex, MiniMax)
					const quotaBadge = ProviderQuotaStore.get().formatBadge(prov || "", theme, ctx.model?.id);
					if (quotaBadge) {
						leftParts.push(quotaBadge);
					}

					// 2. Token Context Window Size & Tokens Used out of 1M / Window
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 1_000_000;
					const contextTokens = contextUsage?.tokens ?? 0;
					const contextPercentValue = contextUsage?.percent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
					const contextPercent = Number.isFinite(contextPercentValue) ? contextPercentValue.toFixed(1) : "0.0";
					const contextStr = `${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${contextPercent}%)`;
					if (contextPercentValue > 90) {
						leftParts.push(theme.fg("error", contextStr));
					} else if (contextPercentValue > 70) {
						leftParts.push(theme.fg("warning", contextStr));
					} else {
						leftParts.push(theme.fg("dim", contextStr));
					}

					let statsLeft = leftParts.join("   ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// Line 2 Right: (oAuth) + Model ID + Thinking level
					const modelName = ctx.model?.id || "no-model";
					const rawThinking = ctx.thinkingLevel || "high";
					const registryOAuth = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					const isOAuth = registryOAuth || prov === "antigravity" || prov === "oauth" || prov === "claude" || prov === "anthropic";
					const isClaude = prov === "oauth" || prov === "claude" || prov === "anthropic";
					const providerLabel = isOAuth ? "oAuth" : (prov || "");

					let thinkingLevel = rawThinking;
					if (isClaude) {
						const claudeLevels: Record<string, string> = {
							minimal: "low",
							low: "medium",
							medium: "high",
							high: "xhigh",
							xhigh: "max",
							max: "ultracode",
						};
						thinkingLevel = claudeLevels[rawThinking] || rawThinking;
					}

					const rightText = providerLabel
						? `(${providerLabel}) ${modelName} • ${thinkingLevel}`
						: `${modelName} • ${thinkingLevel}`;

					const minPadding = 2;
					const availableRight = width - statsLeftWidth - minPadding;
					let statsLine = statsLeft;

					if (availableRight > 0) {
						const truncatedRight = truncateToWidth(theme.fg("dim", rightText), availableRight, "");
						const padding = " ".repeat(Math.max(minPadding, width - statsLeftWidth - visibleWidth(truncatedRight)));
						statsLine = statsLeft + padding + truncatedRight;
					}

					return [
						truncateToWidth(theme.fg("dim", pwd), width),
						truncateToWidth(statsLine, width),
					];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		hookUsageReporting(ctx);
		installCleanFooter(ctx);
		void refreshQuotaSnapshot(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		hookUsageReporting(ctx);
		installCleanFooter(ctx);
		void refreshQuotaSnapshot(ctx);
	});

	// Normalize context overflow errors for Pi automatic compaction
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== "antigravity" && ctx.model?.provider !== "antigravity") return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!CLOUDCODE_OVERFLOW_PATTERN.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});

	pi.registerCommand("codex", {
		description: "OpenAI Codex commands: usage | quota | status",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().split(/\s+/)[0] || "usage";
			if (sub === "status") {
				const model = ctx.model?.provider === "openai-codex"
					? ctx.model
					: ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === "openai-codex");
				const usingOAuth = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
				ctx.ui.notify(
					usingOAuth
						? `OpenAI Codex: OAuth active${model ? ` • ${model.id}` : ""}`
						: "OpenAI Codex OAuth is not active. Run /login and select ChatGPT Plus/Pro (Codex).",
					usingOAuth ? "info" : "warning",
				);
				return;
			}
			if (sub === "usage" || sub === "quota") {
				ctx.ui.notify("Fetching live OpenAI Codex quota…", "info");
				const snapshot = await fetchCodexQuotaForContext(ctx, 8_000);
				if (snapshot.ok) {
					ProviderQuotaStore.get().updateFromCodexSnapshot(snapshot);
					lastQuotaFetchByProvider.set("openai-codex", Date.now());
				}
				ctx.ui.notify(
					formatCodexQuotaSnapshot(snapshot, ctx.model?.provider === "openai-codex" ? ctx.model.id : undefined),
					snapshot.ok ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify("Usage: /codex <usage|quota|status>", "info");
		},
	});

	pi.registerCommand("agy", {
		description: "Antigravity commands: status | models | quota | usage | auth | login",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().split(/\s+/)[0] || "status";

			if (sub === "models") {
				const lines = GEMINI_MODELS.map((m) => {
					const mark = m.id === PREFERRED_MODEL_ID ? "  <- default pick" : "";
					return `  ${m.id} (${m.name})\n    backend=${m.backend}, effort=${m.effort}, maxTokens=${m.maxTokens}${mark}`;
				}).join("\n");
				ctx.ui.notify(`Antigravity models (native Cloud Code stream):\n${lines}`, "info");
				return;
			}

			if (sub === "auth" || sub === "status") {
				const status = await client.getStatus(PREFERRED_MODEL_ID);
				if (!status.connected) {
					ctx.ui.notify(
						`Antigravity OAuth: NOT logged in (${status.error ?? "No session"}). Run \`agy\` in a terminal, then /reload.`,
						"warn",
					);
					return;
				}
				ctx.ui.notify(
					`Antigravity Connected:\n` +
					`• Cloud Code Project: ${status.project}\n` +
					`• OAuth Token: Active (${status.tokenRemainingMinutes ?? 0}m until auto-refresh)\n` +
					`• Endpoint: ${status.endpoint}\n` +
					`• Default Model: ${status.defaultModel} (64k output)\n` +
					`• Safety Overrides: BLOCK_NONE (clean coding/debugging)\n` +
					`• Status: High-speed native stream, $0 API cost`,
					"info",
				);
				return;
			}

			if (sub === "quota" || sub === "usage") {
				ctx.ui.notify("Fetching live Antigravity quota from agy…", "info");
				const snapshot = await fetchAgyQuota();
				ctx.ui.notify(formatQuotaSnapshot(snapshot), snapshot.ok ? "info" : "warn");
				return;
			}

			if (sub === "login") {
				ctx.ui.notify("Run `agy` interactively in a terminal to login, then /reload and /agy status.", "info");
				return;
			}

			ctx.ui.notify("Usage: /agy <status|models|quota|usage|auth|login>", "info");
		},
	});
}
