import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple as streamCodex,
} from "@earendil-works/pi-ai";
import { isRecord } from "./value-guards.js";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_SKEW_MS = 180_000;

interface CodexCredential {
	index: number;
	access: string;
	refresh?: string;
	expires: number;
	accountId?: string;
}

const SOL_ULTRA_MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol Ultra [Claude Failover]",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

class CodexFallbackTokenStore {
	private refreshPromises = new Map<number, Promise<CodexCredential>>();
	private nextIndex = 0;

	constructor(
		private readonly authFilePath = CodexFallbackTokenStore.defaultAuthPath(),
	) {}

	public async getAccessToken(): Promise<string> {
		const credentials = this.readCredentials();
		if (credentials.length === 0) {
			throw new Error(
				"Sol Ultra failover unavailable: no openai-codex OAuth credential is configured",
			);
		}
		for (let offset = 0; offset < credentials.length; offset += 1) {
			const index = (this.nextIndex + offset) % credentials.length;
			const credential = credentials[index];
			if (!credential) continue;
			this.nextIndex = (index + 1) % credentials.length;
			if (credential.expires - Date.now() > TOKEN_REFRESH_SKEW_MS)
				return credential.access;
			if (!credential.refresh) continue;
			try {
				return (await this.refreshCredential(credential)).access;
			} catch {
				// Try the next independently refreshable Codex profile.
			}
		}
		throw new Error(
			"Sol Ultra failover unavailable: no healthy openai-codex OAuth credential remains",
		);
	}

	private readCredentials(): CodexCredential[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(this.authFilePath, "utf8"));
		} catch {
			return [];
		}
		if (!isRecord(parsed)) return [];
		const raw = parsed["openai-codex"];
		const entries = Array.isArray(raw) ? raw : [raw];
		const credentials: CodexCredential[] = [];
		entries.forEach((entry, index) => {
			if (!isRecord(entry) || typeof entry.access !== "string") return;
			credentials.push({
				index,
				access: entry.access,
				refresh: typeof entry.refresh === "string" ? entry.refresh : undefined,
				expires: typeof entry.expires === "number" ? entry.expires : 0,
				accountId:
					typeof entry.accountId === "string" ? entry.accountId : undefined,
			});
		});
		return credentials;
	}

	private async refreshCredential(
		credential: CodexCredential,
	): Promise<CodexCredential> {
		const existing = this.refreshPromises.get(credential.index);
		if (existing) return existing;
		const refresh = this.performRefresh(credential);
		this.refreshPromises.set(credential.index, refresh);
		try {
			return await refresh;
		} finally {
			this.refreshPromises.delete(credential.index);
		}
	}

	private async performRefresh(
		credential: CodexCredential,
	): Promise<CodexCredential> {
		const refreshToken = credential.refresh;
		if (!refreshToken)
			throw new Error("openai-codex OAuth profile has no refresh token");
		const response = await fetch(CODEX_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CODEX_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`openai-codex OAuth refresh failed (${response.status})`);
		}
		const data: unknown = await response.json();
		if (
			!isRecord(data) ||
			typeof data.access_token !== "string" ||
			typeof data.expires_in !== "number"
		) {
			throw new Error("openai-codex OAuth refresh returned an invalid payload");
		}
		const refreshed: CodexCredential = {
			...credential,
			access: data.access_token,
			refresh:
				typeof data.refresh_token === "string"
					? data.refresh_token
					: credential.refresh,
			expires: Date.now() + data.expires_in * 1000,
		};
		this.persist(refreshed);
		return refreshed;
	}

	private persist(credential: CodexCredential): void {
		const root: Record<string, unknown> = (() => {
			try {
				const parsed: unknown = JSON.parse(
					fs.readFileSync(this.authFilePath, "utf8"),
				);
				return isRecord(parsed) ? parsed : {};
			} catch {
				return {};
			}
		})();
		const stored = root["openai-codex"];
		const replacement = {
			type: "oauth",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
			accountId: credential.accountId,
		};
		if (Array.isArray(stored)) {
			const next = [...stored];
			next[credential.index] = {
				...(isRecord(next[credential.index]) ? next[credential.index] : {}),
				...replacement,
			};
			root["openai-codex"] = next;
		} else {
			root["openai-codex"] = {
				...(isRecord(stored) ? stored : {}),
				...replacement,
			};
		}
		const directory = path.dirname(this.authFilePath);
		if (!fs.existsSync(directory))
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.authFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		fs.writeFileSync(temporaryPath, JSON.stringify(root, null, 2), {
			mode: 0o600,
		});
		fs.renameSync(temporaryPath, this.authFilePath);
	}

	private static defaultAuthPath(): string {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return path.join(home, ".pi", "agent", "auth.json");
	}
}

const fallbackTokenStore = new CodexFallbackTokenStore();

export async function* streamSolUltraFallback(
	context: Context,
	options?: SimpleStreamOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const apiKey = await fallbackTokenStore.getAccessToken();
	const inner = streamCodex(SOL_ULTRA_MODEL, context, {
		...options,
		apiKey,
		reasoning: "max",
		maxTokens: SOL_ULTRA_MODEL.maxTokens,
	});
	for await (const event of inner) yield event;
}
