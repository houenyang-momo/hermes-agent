export type CodexQuotaWindow = {
	remainingPct: number;
	windowSeconds?: number;
	resetAt?: number;
};

export type CodexQuotaSnapshot = {
	ok: boolean;
	planType?: string;
	general?: CodexQuotaWindow;
	spark?: CodexQuotaWindow;
	fetchedAt: number;
	error?: string;
};

export type CodexRequestAuth = {
	apiKey: string;
	baseUrl?: string;
	headers?: Record<string, string | null | undefined>;
};

export type CodexQuotaFetchOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function parseWindow(value: unknown): CodexQuotaWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = finiteNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const remainingPct = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
	const windowSeconds = finiteNumber(window.limit_window_seconds);
	const resetAt = finiteNumber(window.reset_at);
	return {
		remainingPct,
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function selectWeeklyWindow(rateLimitValue: unknown): CodexQuotaWindow | undefined {
	const rateLimit = asRecord(rateLimitValue);
	if (!rateLimit) return undefined;
	const windows = [parseWindow(rateLimit.primary_window), parseWindow(rateLimit.secondary_window)]
		.filter((window): window is CodexQuotaWindow => Boolean(window));
	if (windows.length === 0) return undefined;
	return windows.sort((a, b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0))[0];
}

function isSparkLimit(limit: JsonRecord): boolean {
	const name = String(limit.limit_name ?? "");
	const feature = String(limit.metered_feature ?? "");
	return /gpt-?5\.3.*spark/i.test(name) || /codex_bengalfox/i.test(feature);
}

export function parseCodexQuotaPayload(payloadValue: unknown): CodexQuotaSnapshot {
	const fetchedAt = Date.now();
	const payload = asRecord(payloadValue);
	if (!payload) return { ok: false, fetchedAt, error: "Invalid Codex usage response" };

	const general = selectWeeklyWindow(payload.rate_limit);
	const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
	const sparkLimit = additional.map(asRecord).find((limit): limit is JsonRecord => Boolean(limit && isSparkLimit(limit)));
	const spark = selectWeeklyWindow(sparkLimit?.rate_limit);
	const planType = typeof payload.plan_type === "string" ? payload.plan_type : undefined;

	return {
		ok: Boolean(general),
		...(planType ? { planType } : {}),
		...(general ? { general } : {}),
		...(spark ? { spark } : {}),
		fetchedAt,
		...(!general ? { error: "General Codex quota window unavailable" } : {}),
	};
}

export function resolveCodexUsageUrl(baseUrl = ""): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) normalized = "https://chatgpt.com/backend-api/codex";
	if (normalized.endsWith("/codex")) normalized = normalized.slice(0, -"/codex".length);
	return `${normalized}${normalized.includes("/backend-api") ? "/wham" : "/api/codex"}/usage`;
}

export function formatCodexModelLabel(modelId?: string): string {
	const match = String(modelId ?? "").match(/gpt[-_ ]?(\d+(?:\.\d+)?)/i);
	return match ? `GPT${match[1]}` : "Codex";
}

function extractAccountId(accessToken: string): string | undefined {
	try {
		const payload = accessToken.split(".")[1];
		if (!payload) return undefined;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JsonRecord;
		const auth = asRecord(claims["https://api.openai.com/auth"]);
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id
			? auth.chatgpt_account_id
			: undefined;
	} catch {
		return undefined;
	}
}

function requestSignal(options: CodexQuotaFetchOptions): AbortSignal {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 4_000);
	return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export async function fetchCodexQuota(
	auth: CodexRequestAuth,
	options: CodexQuotaFetchOptions = {},
): Promise<CodexQuotaSnapshot> {
	const fetchedAt = Date.now();
	if (!auth.apiKey) return { ok: false, fetchedAt, error: "Codex OAuth credential unavailable" };

	try {
		const headers = new Headers();
		for (const [key, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headers.set(key, value);
		}
		headers.set("authorization", `Bearer ${auth.apiKey}`);
		headers.set("accept", "application/json");
		headers.set("user-agent", "codex-cli");
		if (!headers.has("chatgpt-account-id")) {
			const accountId = extractAccountId(auth.apiKey);
			if (accountId) headers.set("chatgpt-account-id", accountId);
		}

		const response = await (options.fetchImpl ?? fetch)(resolveCodexUsageUrl(auth.baseUrl), {
			headers,
			signal: requestSignal(options),
		});
		if (!response.ok) {
			return { ok: false, fetchedAt, error: `Codex usage request failed (HTTP ${response.status})` };
		}
		return parseCodexQuotaPayload(await response.json());
	} catch (error) {
		const message = error instanceof Error && error.name === "TimeoutError"
			? "Codex usage request timed out"
			: "Codex usage request unavailable";
		return { ok: false, fetchedAt, error: message };
	}
}

function formatReset(resetAt?: number): string {
	if (resetAt === undefined) return "reset unknown";
	return `resets ${new Date(resetAt * 1000).toLocaleString()}`;
}

export function formatCodexQuotaSnapshot(snapshot: CodexQuotaSnapshot, modelId?: string): string {
	if (!snapshot.ok || !snapshot.general) return snapshot.error ?? "Codex usage unavailable";
	const modelLabel = formatCodexModelLabel(modelId);
	const lines = [
		`OpenAI Codex OAuth${snapshot.planType ? ` (${snapshot.planType})` : ""}`,
		`${modelLabel} weekly: ${snapshot.general.remainingPct}% remaining • ${formatReset(snapshot.general.resetAt)}`,
		snapshot.spark
			? `GPT5.3 Spark: ${snapshot.spark.remainingPct}% remaining • ${formatReset(snapshot.spark.resetAt)}`
			: "GPT5.3 Spark: unavailable",
	];
	return lines.join("\n");
}
