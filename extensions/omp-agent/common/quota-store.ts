/**
 * Unified Provider Quota & Rate-Limit Telemetry Store for Pi Agent.
 *
 * Consolidates rolling quota tracking across:
 * - Claude (Anthropic Unified Rate Limits: 5h rolling, 7d weekly, and fallback/overage capacity)
 * - Gemini (Antigravity Cloud Code buckets: 5h rolling and weekly)
 * - OpenAI Codex (general weekly and GPT-5.3 Codex Spark weekly)
 * - MiniMax (M3 concurrency & token balance limits)
 *
 * Exposes a normalized reactive store and status bar badge formatter.
 */

import {
	type CodexQuotaSnapshot,
	formatCodexModelLabel,
} from "../codex/quota.js";

export interface NormalizedQuota {
	provider: string;
	ok: boolean;
	fiveHourRemainingPct?: number; // 0 to 100
	weeklyRemainingPct?: number; // 0 to 100
	fallbackRemainingPct?: number; // 0 to 100 (Anthropic fallback capacity)
	fallbackStatus?: string; // e.g. "available" | "exhausted"
	overageStatus?: string; // e.g. "allowed" | "rejected"
	resetMinutes?: number;
	resetEpochMs?: number;
	weeklyResetSec?: number;
	codexGeneralRemainingPct?: number;
	codexSparkRemainingPct?: number;
	codexGeneralResetSec?: number;
	codexSparkResetSec?: number;
	isExhausted: boolean;
	organizationId?: string;
	workspaceId?: string;
	statusMessage?: string;
	lastUpdated: number;
}

export interface ProviderFailoverMetric {
	sourceProvider: string;
	targetProvider: string;
	targetModel: string;
	reason: string;
	status?: number;
	count: number;
	lastFailedAt: number;
	cooldownUntil: number;
}

export interface RecordFailoverInput {
	sourceProvider: string;
	targetProvider: string;
	targetModel: string;
	reason: string;
	status?: number;
	cooldownMs: number;
}
export function formatCountdown(minutes: number): string {
	if (minutes <= 0) return "0m";
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h > 0 && m > 0) return `${h}h ${m}m`;
	if (h > 0 && m === 0) return `${h}h`;
	return `${m}m`;
}
export function formatTokens(count: number): string {
	if (!count || count <= 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 1_000_000) {
		const k = count / 1000;
		return Number.isInteger(k) ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
	}
	if (count < 1_000_000_000) {
		const m = count / 1_000_000;
		return Number.isInteger(m) ? `${m}M` : `${parseFloat(m.toFixed(1))}M`;
	}
	const b = count / 1_000_000_000;
	return Number.isInteger(b) ? `${b}B` : `${parseFloat(b.toFixed(1))}B`;
}


function normalizeProvider(provider: string): string {
	const normalized = provider.toLowerCase();
	if (
		normalized === "oauth" ||
		normalized === "claude" ||
		normalized === "anthropic"
	)
		return "claude";
	if (
		normalized === "antigravity" ||
		normalized === "gemini" ||
		normalized === "google"
	)
		return "antigravity";
	if (normalized === "openai-codex" || normalized === "codex")
		return "openai-codex";
	return normalized;
}

export type QuotaChangeListener = (
	provider: string,
	quota: NormalizedQuota,
) => void;

export class ProviderQuotaStore {
	private static instance: ProviderQuotaStore;
	private quotas = new Map<string, NormalizedQuota>();
	private listeners = new Set<QuotaChangeListener>();
	private failoverMetrics = new Map<string, ProviderFailoverMetric>();
	private cooldownUntilByProvider = new Map<string, number>();

	public static get(): ProviderQuotaStore {
		if (!ProviderQuotaStore.instance) {
			ProviderQuotaStore.instance = new ProviderQuotaStore();
		}
		return ProviderQuotaStore.instance;
	}

	public subscribe(listener: QuotaChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(provider: string, quota: NormalizedQuota) {
		this.quotas.set(provider, quota);
		for (const listener of this.listeners) {
			try {
				listener(provider, quota);
			} catch {}
		}
	}

	public recordFailover(input: RecordFailoverInput): ProviderFailoverMetric {
		const sourceProvider = normalizeProvider(input.sourceProvider);
		const targetProvider = normalizeProvider(input.targetProvider);
		const now = Date.now();
		const cooldownUntil = now + Math.max(0, input.cooldownMs);
		const key = `${sourceProvider}->${targetProvider}`;
		const previous = this.failoverMetrics.get(key);
		const metric: ProviderFailoverMetric = {
			sourceProvider,
			targetProvider,
			targetModel: input.targetModel,
			reason: input.reason,
			...(input.status !== undefined ? { status: input.status } : {}),
			count: (previous?.count ?? 0) + 1,
			lastFailedAt: now,
			cooldownUntil,
		};
		this.failoverMetrics.set(key, metric);
		this.cooldownUntilByProvider.set(sourceProvider, cooldownUntil);

		const quota: NormalizedQuota = {
			...(this.quotas.get(sourceProvider) ?? {
				provider: sourceProvider,
				ok: true,
			}),
			isExhausted: true,
			resetMinutes: Math.ceil(input.cooldownMs / 60_000),
			statusMessage: `${input.reason}; failing over to ${targetProvider}/${input.targetModel}`,
			lastUpdated: now,
		};
		this.notify(sourceProvider, quota);
		return metric;
	}

	public getFailoverMetrics(
		sourceProvider: string,
		targetProvider: string,
	): ProviderFailoverMetric | undefined {
		return this.failoverMetrics.get(
			`${normalizeProvider(sourceProvider)}->${normalizeProvider(targetProvider)}`,
		);
	}

	public isCoolingDown(provider: string, now = Date.now()): boolean {
		const normalized = normalizeProvider(provider);
		const cooldownUntil = this.cooldownUntilByProvider.get(normalized) ?? 0;
		if (cooldownUntil > now) return true;
		if (cooldownUntil !== 0) this.cooldownUntilByProvider.delete(normalized);
		return false;
	}

	public getCooldownRemainingMs(provider: string, now = Date.now()): number {
		const cooldownUntil =
			this.cooldownUntilByProvider.get(normalizeProvider(provider)) ?? 0;
		return Math.max(0, cooldownUntil - now);
	}

	public getQuota(provider?: string): NormalizedQuota | undefined {
		if (!provider) return undefined;
		return this.quotas.get(normalizeProvider(provider));
	}

	public updateFromAnthropicHeaders(
		headers: Headers | Record<string, string | null | undefined>,
	): NormalizedQuota {
		const getH = (key: string): string | undefined => {
			if (typeof (headers as Headers).get === "function") {
				return (headers as Headers).get(key) || undefined;
			}
			return (
				(headers as Record<string, string>)[key] ||
				(headers as Record<string, string>)[key.toLowerCase()] ||
				undefined
			);
		};

		const fhUtil = getH("anthropic-ratelimit-unified-5h-utilization");
		const sdUtil = getH("anthropic-ratelimit-unified-7d-utilization");
		const fbPct = getH("anthropic-ratelimit-unified-fallback-percentage");
		const fbStatus = getH("anthropic-ratelimit-unified-fallback");
		const overageStatus = getH("anthropic-ratelimit-unified-overage-status");
		const fhReset = getH("anthropic-ratelimit-unified-5h-reset");
		const sdReset = getH("anthropic-ratelimit-unified-7d-reset");
		const fhStatus = getH("anthropic-ratelimit-unified-5h-status");
		const orgId = getH("anthropic-organization-id");
		const wkId = getH("anthropic-workspace-id");

		const fhUsed =
			fhUtil !== undefined && fhUtil !== null ? parseFloat(fhUtil) : 0;
		const sdUsed =
			sdUtil !== undefined && sdUtil !== null ? parseFloat(sdUtil) : 0;
		const fhRemaining = Math.max(
			0,
			Math.min(100, Math.round((1 - fhUsed) * 100)),
		);
		const sdRemaining = Math.max(
			0,
			Math.min(100, Math.round((1 - sdUsed) * 100)),
		);
		const fallbackRemaining =
			fbPct !== undefined && fbPct !== null
				? Math.round(parseFloat(fbPct) * 100)
				: undefined;
		const resetEpochMs = fhReset ? parseInt(fhReset, 10) * 1000 : undefined;
		const resetMinutes = resetEpochMs
			? Math.max(
					0,
					Math.round((resetEpochMs - Date.now()) / 60_000),
				)
			: undefined;

		const isExhausted = fhStatus === "rejected" || fhRemaining <= 0;

		const quota: NormalizedQuota = {
			provider: "claude",
			ok: true,
			fiveHourRemainingPct: fhRemaining,
			weeklyRemainingPct: sdRemaining,
			fallbackRemainingPct: fallbackRemaining,
			fallbackStatus: fbStatus,
			overageStatus: overageStatus,
			...(resetMinutes !== undefined ? { resetMinutes } : {}),
			...(resetEpochMs !== undefined ? { resetEpochMs } : {}),
			weeklyResetSec: sdReset ? parseInt(sdReset, 10) : undefined,
			isExhausted,
			organizationId: orgId,
			workspaceId: wkId,
			lastUpdated: Date.now(),
		};

		this.notify("claude", quota);
		return quota;
	}

	public updateFromAgySnapshot(snapshot: {
		ok: boolean;
		groups?: Array<{
			name: string;
			buckets: Array<{
				name: string;
				window?: string;
				remainingFraction?: number;
				resetTime?: string;
			}>;
		}>;
	}): NormalizedQuota {
		if (!snapshot.ok || !snapshot.groups?.length) {
			const fallback: NormalizedQuota = {
				provider: "antigravity",
				ok: false,
				isExhausted: false,
				lastUpdated: Date.now(),
			};
			this.notify("antigravity", fallback);
			return fallback;
		}

		const gemini =
			snapshot.groups.find((g) => /gemini/i.test(g.name)) ?? snapshot.groups[0];
		const fh = gemini?.buckets.find(
			(b) => /5.*hour/i.test(b.name) || b.window === "5h",
		);
		const wk = gemini?.buckets.find(
			(b) => /week/i.test(b.name) || b.window === "weekly",
		);

		const fhPct = Math.round((fh?.remainingFraction ?? 1) * 100);
		const wkPct = Math.round((wk?.remainingFraction ?? 1) * 100);
		const resetEpochMs = fh?.resetTime ? Date.parse(fh.resetTime) : undefined;
		const resetMinutes = resetEpochMs
			? Math.max(
					0,
					Math.round((resetEpochMs - Date.now()) / 60_000),
				)
			: undefined;
		const isExhausted = fhPct <= 0;

		const quota: NormalizedQuota = {
			provider: "antigravity",
			ok: true,
			fiveHourRemainingPct: fhPct,
			weeklyRemainingPct: wkPct,
			...(resetMinutes !== undefined ? { resetMinutes } : {}),
			...(resetEpochMs !== undefined ? { resetEpochMs } : {}),
			weeklyResetSec: wk?.resetTime
				? Math.round(Date.parse(wk.resetTime) / 1000)
				: undefined,
			isExhausted,
			lastUpdated: Date.now(),
		};

		this.notify("antigravity", quota);
		this.notify("google-antigravity", { ...quota, provider: "google-antigravity" });
		this.notify("google", { ...quota, provider: "google" });
		return quota;
	}

	public updateFromCodexSnapshot(
		snapshot: CodexQuotaSnapshot,
	): NormalizedQuota {
		const general = snapshot.general?.remainingPct;
		const spark = snapshot.spark?.remainingPct;
		const quota: NormalizedQuota = {
			provider: "openai-codex",
			ok: snapshot.ok && general !== undefined,
			...(general !== undefined ? { codexGeneralRemainingPct: general } : {}),
			...(spark !== undefined ? { codexSparkRemainingPct: spark } : {}),
			...(snapshot.general?.resetAt !== undefined
				? {
						codexGeneralResetSec: snapshot.general.resetAt,
						resetEpochMs: snapshot.general.resetAt * 1000,
						resetMinutes: Math.max(
							0,
							Math.round((snapshot.general.resetAt * 1000 - Date.now()) / 60_000),
						),
					}
				: {}),
			...(snapshot.spark?.resetAt !== undefined
				? { codexSparkResetSec: snapshot.spark.resetAt }
				: {}),
			isExhausted: general !== undefined && general <= 0,
			statusMessage: snapshot.error,
			lastUpdated: snapshot.fetchedAt || Date.now(),
		};
		this.notify("openai-codex", quota);
		return quota;
	}

	public formatBadge(
		provider: string,
		theme: { fg: (color: string, text: string) => string },
		modelId?: string,
	): string | undefined {
		const q = this.getQuota(provider);
		if (!q?.ok) return undefined;

		const normalizedProvider = provider.toLowerCase();
		if (
			normalizedProvider === "openai-codex" ||
			normalizedProvider === "codex"
		) {
			const general = q.codexGeneralRemainingPct;
			if (general === undefined) return undefined;
			const spark = q.codexSparkRemainingPct;
			const lowest = spark === undefined ? general : Math.min(general, spark);
			const icon = lowest <= 0 ? "⛔" : lowest < 20 ? "⚠️" : "⚡";
			const colorFor = (value: number | undefined) =>
				value === undefined
					? "dim"
					: value <= 0
						? "error"
						: value < 20
							? "warning"
							: "accent";
			let generalTimer = "";
			let remMin: number | undefined;
			if (q.resetEpochMs !== undefined) {
				remMin = Math.max(0, Math.round((q.resetEpochMs - Date.now()) / 60_000));
			} else if (q.codexGeneralResetSec !== undefined) {
				remMin = Math.max(0, Math.round((q.codexGeneralResetSec * 1000 - Date.now()) / 60_000));
			} else if (q.resetMinutes !== undefined) {
				remMin = Math.max(0, q.resetMinutes);
			}
			if (remMin !== undefined) {
				generalTimer = ` (${formatCountdown(remMin)})`;
			}
			const generalText = theme.fg(
				colorFor(general),
				`${icon} ${formatCodexModelLabel(modelId)} wk: ${general}% rem${generalTimer}`,
			);
			const sparkText = theme.fg(
				colorFor(spark),
				`GPT5.3: ${spark === undefined ? "?" : spark}% rem`,
			);
			return `${generalText} • ${sparkText}`;
		}

		const fhPct = q.fiveHourRemainingPct ?? 100;
		const wkPct = q.weeklyRemainingPct ?? 100;
		const weekLabel = "7d";

		let remMin: number | undefined;
		if (q.resetEpochMs !== undefined) {
			remMin = Math.max(0, Math.round((q.resetEpochMs - Date.now()) / 60_000));
		} else if (q.resetMinutes !== undefined) {
			remMin = Math.max(0, q.resetMinutes);
		}
		const resetSuffix = remMin !== undefined ? ` (${formatCountdown(remMin)})` : "";

		if (q.isExhausted || fhPct <= 0) {
			return theme.fg(
				"error",
				`⛔ 5h: ${fhPct}% rem${resetSuffix} • ${weekLabel}: ${wkPct}% rem`,
			);
		} else if (fhPct < 20) {
			return theme.fg(
				"warning",
				`⚠️ 5h: ${fhPct}% rem${resetSuffix} • ${weekLabel}: ${wkPct}% rem`,
			);
		} else {
			return theme.fg(
				"accent",
				`⚡ 5h: ${fhPct}% rem${resetSuffix} • ${weekLabel}: ${wkPct}% rem`,
			);
		}
	}
}
