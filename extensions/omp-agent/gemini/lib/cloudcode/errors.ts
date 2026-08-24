export interface CloudCodeQuotaInfo {
	exhausted: boolean;
	retryable: boolean;
	model?: string;
	resetDelay?: string;
	resetAt?: string;
	message?: string;
}

function parseRetryDelaySeconds(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw !== "string") return 0;
	const match = raw.trim().match(/^(\d+(?:\.\d+)?)s?$/);
	return match ? Number(match[1]) : 0;
}

export function parseCloudCodeError(body: string): CloudCodeQuotaInfo {
	try {
		const parsed = JSON.parse(body) as {
			error?: {
				code?: number;
				message?: string;
				status?: string;
				details?: Array<Record<string, unknown>>;
			};
		};
		const error = parsed.error;
		const details = Array.isArray(error?.details) ? error.details : [];
		const info = details.find((d) => d.reason === "QUOTA_EXHAUSTED" || String(d["@type"] || "").includes("ErrorInfo"));
		const retryInfo = details.find((d) => d.retryDelay !== undefined);
		const metadata = (info?.metadata && typeof info.metadata === "object")
			? info.metadata as Record<string, string>
			: {};
		const delaySec = parseRetryDelaySeconds(retryInfo?.retryDelay ?? metadata.quotaResetDelay);
		const exhausted = error?.status === "RESOURCE_EXHAUSTED"
			|| info?.reason === "QUOTA_EXHAUSTED"
			|| /quota reached|quota exhausted|resource.?exhausted/i.test(error?.message || "");

		return {
			exhausted,
			retryable: !exhausted && delaySec > 0 && delaySec <= 15,
			model: metadata.model,
			resetDelay: metadata.quotaResetDelay || (delaySec > 0 ? `${Math.round(delaySec)}s` : undefined),
			resetAt: metadata.quotaResetTimeStamp,
			message: error?.message,
		};
	} catch {
		return { exhausted: false, retryable: true };
	}
}

export function formatCloudCodeHttpError(status: number, body: string): string {
	if (status === 429) {
		const quota = parseCloudCodeError(body);
		if (quota.exhausted) {
			const model = quota.model || "gemini-3.7-flash-tiered";
			const reset = quota.resetAt
				? ` Resets at ${quota.resetAt}${quota.resetDelay ? ` (in ${quota.resetDelay})` : ""}.`
				: quota.resetDelay
					? ` Resets in ${quota.resetDelay}.`
					: "";
			return (
				`Cloud Code quota exhausted for ${model}.${reset} ` +
				`This is an account limit, not an extension crash. ` +
				`Gemini Flash/Pro share this 5-hour Cloud Code bucket — switching 3.7→3.6 will not help. ` +
				`Wait for the reset, use Claude/GPT in agy, MiniMax in Pi, or G1/AI credits if your plan allows. ` +
				`Check live remaining with /agy quota.`
			);
		}
	}
	return `Cloud Code ${status}: ${body.slice(0, 800)}`;
}
