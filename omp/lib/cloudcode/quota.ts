import { spawn } from "node:child_process";

export interface QuotaBucket {
	id?: string;
	name: string;
	description?: string;
	window?: string;
	remainingFraction: number;
	resetTime?: string;
}

export interface QuotaGroup {
	name: string;
	description?: string;
	buckets: QuotaBucket[];
}

export interface QuotaSnapshot {
	ok: boolean;
	error?: string;
	description?: string;
	groups: QuotaGroup[];
}

interface AgyQuotaPayload {
	status?: string;
	command?: {
		name?: string;
		data?: {
			description?: string;
			groups?: Array<{
				name?: string;
				description?: string;
				buckets?: Array<{
					id?: string;
					name?: string;
					description?: string;
					window?: string;
					remaining_fraction?: number;
					reset_time?: string;
				}>;
			}>;
		};
	};
	error?: { message?: string };
}

export function parseAgyQuotaPayload(raw: string): QuotaSnapshot {
	const parsed = JSON.parse(raw) as AgyQuotaPayload;
	if (parsed.status && parsed.status !== "SUCCESS") {
		return { ok: false, error: parsed.error?.message || `agy quota status ${parsed.status}`, groups: [] };
	}
	const groups = (parsed.command?.data?.groups ?? []).map((group) => ({
		name: group.name || "Unknown group",
		description: group.description,
		buckets: (group.buckets ?? []).map((bucket) => ({
			id: bucket.id,
			name: bucket.name || "Limit",
			description: bucket.description,
			window: bucket.window,
			remainingFraction: typeof bucket.remaining_fraction === "number" ? bucket.remaining_fraction : 0,
			resetTime: bucket.reset_time,
		})),
	}));
	if (groups.length === 0) {
		return { ok: false, error: "agy returned no quota groups", groups: [] };
	}
	return {
		ok: true,
		description: parsed.command?.data?.description,
		groups,
	};
}

function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

function resetLabel(iso?: string): string {
	if (!iso) return "unknown reset";
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	const deltaMin = Math.max(0, Math.round((ms - Date.now()) / 60_000));
	if (deltaMin < 60) return `${iso} (~${deltaMin}m)`;
	const hours = Math.floor(deltaMin / 60);
	const mins = deltaMin % 60;
	return `${iso} (~${hours}h${mins ? ` ${mins}m` : ""})`;
}

export function formatQuotaSnapshot(snapshot: QuotaSnapshot): string {
	if (!snapshot.ok) {
		return `Antigravity quota unavailable: ${snapshot.error || "unknown error"}`;
	}
	const lines = ["Antigravity / Cloud Code quota (live from agy, no model tokens spent):"];
	for (const group of snapshot.groups) {
		lines.push(`\n${group.name}`);
		if (group.description) lines.push(`  ${group.description}`);
		for (const bucket of group.buckets) {
			const empty = bucket.remainingFraction <= 0.001 ? "  <- EMPTY" : "";
			lines.push(`  • ${bucket.name}: ${percent(bucket.remainingFraction)} remaining  reset ${resetLabel(bucket.resetTime)}${empty}`);
			if (bucket.description) lines.push(`    ${bucket.description}`);
		}
	}
	if (snapshot.description) {
		lines.push(`\n${snapshot.description}`);
	}
	return lines.join("\n");
}

export async function fetchAgyQuota(timeoutMs = 15_000): Promise<QuotaSnapshot> {
	return new Promise((resolve) => {
		const child = spawn("agy", ["-p", "/quota", "--output-format", "json"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({ ok: false, error: `agy /quota timed out after ${timeoutMs / 1000}s`, groups: [] });
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, error: `agy not runnable: ${error.message}`, groups: [] });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const jsonStart = stdout.indexOf("{");
			if (jsonStart < 0) {
				resolve({
					ok: false,
					error: `agy /quota returned no JSON (exit ${code ?? "?"}): ${(stderr || stdout).trim().slice(0, 240)}`,
					groups: [],
				});
				return;
			}
			try {
				resolve(parseAgyQuotaPayload(stdout.slice(jsonStart)));
			} catch (error) {
				resolve({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					groups: [],
				});
			}
		});
	});
}
