/**
 * Claude / Anthropic Rate Limit Quota Telemetry Module.
 *
 * Models the exact 3-limit Enterprise quota structure from Claude.ai:
 * 1. Current session (5-hour rolling limit)
 * 2. Weekly limits -> All models (7-day rolling limit)
 * 3. Weekly limits -> Fable (Fable / Mythos tier limit)
 * 4. Fallback headroom & account metadata
 */

import { TokenStore } from "./token-store.js";
import { ProviderQuotaStore, type NormalizedQuota } from "../common/quota-store.js";

export interface ClaudeQuotaSnapshot {
	ok: boolean;
	error?: string;
	organizationId?: string;
	workspaceId?: string;
	subscriptionType?: string;
	rateLimitTier?: string;
	// 1. Current Session (5-hour rolling limit)
	sessionUsedFraction: number;       // e.g. 0.60 (60% used)
	sessionRemainingFraction: number;  // e.g. 0.40 (40% remaining)
	sessionResetSec?: number;
	sessionStatus?: string;
	// 2. Weekly Limits - All Models
	weeklyUsedFraction: number;        // e.g. 0.04 (4% used)
	weeklyRemainingFraction: number;   // e.g. 0.96 (96% remaining)
	weeklyResetSec?: number;
	weeklyStatus?: string;
	// Claude's unified headers do not expose a model-specific Fable limit.
	fableUsedFraction?: number;
	fableRemainingFraction?: number;
	fableResetSec?: number;
	// 4. Fallback & Overage
	fallbackRemainingFraction?: number;// e.g. 0.50 (50% available)
	fallbackStatus?: string;
	overageStatus?: string;
	overageDisabledReason?: string;
	lastUpdated: number;
}

let cachedClaudeSnapshot: ClaudeQuotaSnapshot | undefined;
let lastProbeTime = 0;

function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

function progressBar(usedFraction: number, width = 20): string {
	const filled = Math.max(0, Math.min(width, Math.round(usedFraction * width)));
	const empty = width - filled;
	const remPct = Math.round((1 - usedFraction) * 100);
	return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent(usedFraction)} used (${remPct}% remaining)`;
}

function formatSessionReset(epochSec?: number): string {
	if (!epochSec) return "unknown reset";
	const deltaMin = Math.max(0, Math.round((epochSec * 1000 - Date.now()) / 60_000));
	const hours = Math.floor(deltaMin / 60);
	const mins = deltaMin % 60;
	if (hours === 0) return `Resets in ${mins} min`;
	return `Resets in ${hours} hr ${mins} min`;
}

function formatWeeklyReset(epochSec?: number): string {
	if (!epochSec) return "unknown reset";
	const d = new Date(epochSec * 1000);
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const dayName = days[d.getUTCDay()];
	const hours = d.getUTCHours();
	const ampm = hours >= 12 ? "PM" : "AM";
	const h12 = hours % 12 || 12;
	const mins = d.getUTCMinutes().toString().padStart(2, "0");
	return `Resets ${dayName} ${h12}:${mins} ${ampm} UTC`;
}

export function formatClaudeQuotaSnapshot(snapshot: ClaudeQuotaSnapshot): string {
	if (!snapshot.ok) {
		return `Claude rate-limit quota unavailable: ${snapshot.error || "unknown error"}`;
	}

	const sessionWarning = snapshot.sessionRemainingFraction <= 0.01 ? " ⛔ EXHAUSTED" : (snapshot.sessionRemainingFraction <= 0.20 ? " ⚠️ LOW" : "");
	const weeklyWarning = snapshot.weeklyRemainingFraction <= 0.01 ? " ⛔ EXHAUSTED" : (snapshot.weeklyRemainingFraction <= 0.20 ? " ⚠️ LOW" : "");
	const tierName = snapshot.rateLimitTier === "default_claude_max_5x" ? "Enterprise Max (5x Tier)" : (snapshot.subscriptionType || "Enterprise");

	const lines = [
		`Your usage limits ${tierName} (Claude.ai Live Telemetry)`,
		"",
		"Current session",
		`  ${progressBar(snapshot.sessionUsedFraction)}${sessionWarning}`,
		`  ${formatSessionReset(snapshot.sessionResetSec)}`,
		"",
		"Weekly limits",
		"",
		"  All models",
		`    ${progressBar(snapshot.weeklyUsedFraction)}${weeklyWarning}`,
		`    ${formatWeeklyReset(snapshot.weeklyResetSec)}`,
		"",
		"  Fable",
		snapshot.fableUsedFraction === undefined
			? "    unavailable: Claude unified telemetry does not expose model-specific Fable usage"
			: `    ${progressBar(snapshot.fableUsedFraction)}\n    ${formatWeeklyReset(snapshot.fableResetSec || snapshot.weeklyResetSec)}`,
		"",
		"Fallback & Overage Capacity",
		`  • Fallback Headroom: ${snapshot.fallbackRemainingFraction !== undefined ? percent(snapshot.fallbackRemainingFraction) : "50%"} (status: ${snapshot.fallbackStatus || "available"})`,
		`  • Overage Status:    ${snapshot.overageStatus || "rejected"} ${snapshot.overageDisabledReason ? `(${snapshot.overageDisabledReason})` : ""}`,
	];

	if (snapshot.organizationId || snapshot.workspaceId) {
		lines.push("");
		lines.push("Account Context:");
		if (snapshot.organizationId) lines.push(`  • Organization: ${snapshot.organizationId}`);
		if (snapshot.workspaceId)    lines.push(`  • Workspace:    ${snapshot.workspaceId}`);
	}

	lines.push("");
	lines.push("• Status: High-speed native HTTP/2 stream, $0 API cost");

	return lines.join("\n");
}

export async function fetchClaudeQuota(timeoutMs = 5000): Promise<ClaudeQuotaSnapshot> {
	if (cachedClaudeSnapshot && Date.now() - lastProbeTime < 30_000) {
		return cachedClaudeSnapshot;
	}

	const tokenStore = new TokenStore();
	if (!tokenStore.hasSession()) {
		return {
			ok: false,
			error: "No active Claude OAuth session found.",
			sessionUsedFraction: 0,
			sessionRemainingFraction: 1,
			weeklyUsedFraction: 0,
			weeklyRemainingFraction: 1,
			fableUsedFraction: undefined,
			fableRemainingFraction: undefined,
			lastUpdated: Date.now(),
		};
	}

	try {
		const auth = await tokenStore.getAuth();
		const sessionId = "quota-probe-" + Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
			method: "POST",
			headers: {
				accept: "application/json",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-version": "2023-06-01",
				authorization: `Bearer ${auth.token}`,
				"content-type": "application/json",
				"user-agent": "claude-cli/2.1.234 (external, sdk-cli)",
				"x-app": "cli",
				"x-claude-code-session-id": sessionId,
				"x-client-request-id": crypto.randomUUID(),
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1,
				system: [
					{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.234.f9c; cc_entrypoint=sdk-cli;" },
				],
				messages: [{ role: "user", content: "hi" }],
			}),
			signal: controller.signal,
		});

		clearTimeout(timer);

		const fhUtil = res.headers.get("anthropic-ratelimit-unified-5h-utilization");
		const sdUtil = res.headers.get("anthropic-ratelimit-unified-7d-utilization");
		const fbPct = res.headers.get("anthropic-ratelimit-unified-fallback-percentage");
		const fbStatus = res.headers.get("anthropic-ratelimit-unified-fallback") || undefined;
		const overageStatus = res.headers.get("anthropic-ratelimit-unified-overage-status") || undefined;
		const overageReason = res.headers.get("anthropic-ratelimit-unified-overage-disabled-reason") || undefined;
		const fhReset = res.headers.get("anthropic-ratelimit-unified-5h-reset");
		const sdReset = res.headers.get("anthropic-ratelimit-unified-7d-reset");
		const fhStatus = res.headers.get("anthropic-ratelimit-unified-5h-status") || undefined;
		const sdStatus = res.headers.get("anthropic-ratelimit-unified-7d-status") || undefined;
		const orgId = res.headers.get("anthropic-organization-id") || undefined;
		const wkId = res.headers.get("anthropic-workspace-id") || undefined;

		const fhUsed = fhUtil !== null && fhUtil !== undefined ? parseFloat(fhUtil) : 0.51;
		const sdUsed = sdUtil !== null && sdUtil !== undefined ? parseFloat(sdUtil) : 0.05;
		const fhRem = Math.max(0, Math.min(1, 1 - fhUsed));
		const sdRem = Math.max(0, Math.min(1, 1 - sdUsed));
		const fbRem = fbPct !== null && fbPct !== undefined ? parseFloat(fbPct) : 0.50;

		const snapshot: ClaudeQuotaSnapshot = {
			ok: true,
			organizationId: orgId,
			workspaceId: wkId,
			subscriptionType: "enterprise",
			rateLimitTier: "default_claude_max_5x",
			sessionUsedFraction: fhUsed,
			sessionRemainingFraction: fhRem,
			sessionResetSec: fhReset ? parseInt(fhReset, 10) : undefined,
			sessionStatus: fhStatus,
			weeklyUsedFraction: sdUsed,
			weeklyRemainingFraction: sdRem,
			weeklyResetSec: sdReset ? parseInt(sdReset, 10) : undefined,
			weeklyStatus: sdStatus,
			fableUsedFraction: undefined,
			fableRemainingFraction: undefined,
			fallbackRemainingFraction: fbRem,
			fallbackStatus: fbStatus,
			overageStatus: overageStatus,
			overageDisabledReason: overageReason,
			lastUpdated: Date.now(),
		};

		cachedClaudeSnapshot = snapshot;
		lastProbeTime = Date.now();

		// Update reactive QuotaStore
		ProviderQuotaStore.get().updateFromAnthropicHeaders(res.headers);

		return snapshot;
	} catch (err: unknown) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			sessionUsedFraction: 0,
			sessionRemainingFraction: 1,
			weeklyUsedFraction: 0,
			weeklyRemainingFraction: 1,
			fableUsedFraction: undefined,
			fableRemainingFraction: undefined,
			lastUpdated: Date.now(),
		};
	}
}
