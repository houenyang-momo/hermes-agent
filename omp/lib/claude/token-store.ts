import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "../common/value-guards.js";
import type { ClaudeTokenBundle, ResolvedAuth } from "./types.js";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_CLIENT_ID = "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl";
const TOKEN_REFRESH_SKEW_MS = 180_000;
const FAILED_PROFILE_COOLDOWN_MS = 60_000;

export interface TokenStoreOptions {
	authFilePath?: string;
	claudeCredentialsFilePath?: string;
	keychainServices?: () => string[];
	keychainReader?: (service: string) => string | undefined;
	refreshOAuthToken?: (refreshToken: string) => Promise<ClaudeTokenBundle>;
	now?: () => number;
	env?: Record<string, string | undefined>;
}

export interface TokenHealth {
	profileId: string;
	healthy: boolean;
	expiresAt: number;
	cooldownUntil: number;
	error?: string;
}

interface OAuthCandidate {
	id: string;
	source: "claude" | "pi" | "keychain";
	sourceIndex: number;
	accessToken?: string;
	refreshToken?: string;
	expiresAt: number;
	accountUuid?: string;
	cooldownUntil: number;
}

interface StoredOAuthShape {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	access?: string;
	refresh?: string;
	expires?: number;
	accountUuid?: string;
	accountId?: string;
	type?: string;
}

function defaultPiAuthFilePath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return path.join(home, ".pi", "agent", "auth.json");
}

function defaultClaudeCredentialsFilePath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return path.join(home, ".claude", ".credentials.json");
}

function readStoredOAuth(value: unknown): StoredOAuthShape | undefined {
	if (!isRecord(value)) return undefined;
	const stringValue = (key: string): string | undefined =>
		typeof value[key] === "string" ? value[key] : undefined;
	const numberValue = (key: string): number | undefined =>
		typeof value[key] === "number" && Number.isFinite(value[key])
			? value[key]
			: undefined;
	return {
		accessToken: stringValue("accessToken"),
		refreshToken: stringValue("refreshToken"),
		expiresAt: numberValue("expiresAt"),
		access: stringValue("access"),
		refresh: stringValue("refresh"),
		expires: numberValue("expires"),
		accountUuid: stringValue("accountUuid"),
		accountId: stringValue("accountId"),
		type: stringValue("type"),
	};
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeJsonAtomically(
	filePath: string,
	value: Record<string, unknown>,
): void {
	const directory = path.dirname(filePath);
	if (!fs.existsSync(directory))
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
		mode: 0o600,
	});
	fs.renameSync(temporaryPath, filePath);
}

export class TokenStore {
	private readonly authFilePath: string;
	private readonly claudeCredentialsFilePath: string;
	private readonly options: TokenStoreOptions;
	private candidatePool: OAuthCandidate[] = [];
	private poolLoadPromise?: Promise<void>;
	private refreshPromises = new Map<string, Promise<OAuthCandidate>>();
	private persistPromise = Promise.resolve();
	private nextCandidateIndex = 0;
	private lastResolved?: ResolvedAuth;
	private cachedKeychainServices?: { services: string[]; expiresAt: number };
	private cachedKeychainValues = new Map<string, { value?: string; expiresAt: number }>();

	constructor(
		private explicitApiKey?: string,
		private explicitOAuthToken?: string,
		options: TokenStoreOptions = {},
	) {
		this.options = options;
		this.authFilePath = options.authFilePath ?? defaultPiAuthFilePath();
		this.claudeCredentialsFilePath =
			options.claudeCredentialsFilePath ?? defaultClaudeCredentialsFilePath();
	}

	public hasSession(): boolean {
		if (this.resolveExplicitApiKey() || this.resolveExplicitOAuthToken())
			return true;
		const claudeRoot = readJsonFile(this.claudeCredentialsFilePath);
		if (readStoredOAuth(claudeRoot?.claudeAiOauth)) return true;
		const piRoot = readJsonFile(this.authFilePath);
		const stored = piRoot?.anthropic;
		if (
			Array.isArray(stored)
				? stored.some((entry) => readStoredOAuth(entry))
				: readStoredOAuth(stored)
		)
			return true;
		return this.scanKeychainServices().length > 0;
	}

	public invalidateToken(auth = this.lastResolved): void {
		if (!auth || auth.mode === "api-key") return;
		const candidate = this.candidatePool.find(
			(item) => item.id === auth.profileId || item.accessToken === auth.token,
		);
		if (candidate) {
			candidate.accessToken = undefined;
			candidate.expiresAt = 0;
		}
		if (this.lastResolved?.token === auth.token) this.lastResolved = undefined;
	}

	public markRateLimited(auth: ResolvedAuth, cooldownMs: number): void {
		const candidate = this.candidatePool.find(
			(item) => item.id === auth.profileId || item.accessToken === auth.token,
		);
		if (candidate)
			candidate.cooldownUntil = this.now() + Math.max(0, cooldownMs);
	}

	public rotateToken(): boolean {
		if (this.candidatePool.length <= 1) return false;
		this.nextCandidateIndex =
			(this.nextCandidateIndex + 1) % this.candidatePool.length;
		return true;
	}

	public getPoolSize(): number {
		return Math.max(1, this.candidatePool.length);
	}

	public getRemainingMinutes(): number {
		if (!this.lastResolved?.expiresAt) return 0;
		return Math.max(
			0,
			Math.round((this.lastResolved.expiresAt - this.now()) / 60_000),
		);
	}

	public getAuthMode(): "oauth" | "api-key" | "none" {
		if (this.resolveExplicitApiKey()) return "api-key";
		return this.hasSession() ? "oauth" : "none";
	}

	public getMetadata(
		sessionId: string,
		auth = this.lastResolved,
	): { user_id: string } {
		return {
			user_id: JSON.stringify({
				device_id:
					"a1ec583dad7f596bdb2c4d177d4d37724992310e49e62836e5f35546e00ea310",
				account_uuid:
					auth?.accountUuid ?? "8c34d33b-4a33-4897-b537-827cb9873b5e",
				session_id: sessionId,
			}),
		};
	}

	public async getAuth(): Promise<ResolvedAuth> {
		const apiKey = this.resolveExplicitApiKey();
		if (apiKey) return { token: apiKey, mode: "api-key" };
		const oauthToken = this.resolveExplicitOAuthToken();
		if (oauthToken) {
			const auth: ResolvedAuth = {
				token: oauthToken,
				mode: "oauth",
				profileId: "explicit-oauth",
				expiresAt: this.now() + 3_600_000,
			};
			this.lastResolved = auth;
			return auth;
		}

		await this.ensurePoolLoaded();
		if (this.candidatePool.length === 0) {
			throw new Error(
				"Claude authentication not found. Run `/login anthropic` or set ANTHROPIC_API_KEY in your environment, then /reload.",
			);
		}

		const now = this.now();
		const errors: string[] = [];
		const startIndex = this.nextCandidateIndex;
		this.nextCandidateIndex = (startIndex + 1) % this.candidatePool.length;
		for (let offset = 0; offset < this.candidatePool.length; offset += 1) {
			const index = (startIndex + offset) % this.candidatePool.length;
			const candidate = this.candidatePool[index];
			if (!candidate || candidate.cooldownUntil > now) continue;
			try {
				const healthy = await this.resolveCandidate(candidate);
				if (!healthy.accessToken)
					throw new Error("profile refresh returned no access token");
				const auth: ResolvedAuth = {
					token: healthy.accessToken,
					mode: "oauth",
					profileId: healthy.id,
					accountUuid: healthy.accountUuid,
					expiresAt: healthy.expiresAt,
				};
				this.lastResolved = auth;
				this.nextCandidateIndex = (index + 1) % this.candidatePool.length;
				return auth;
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				if (errMsg.includes("invalid_grant") || errMsg.includes("expired") || errMsg.includes("not found")) {
					candidate.cooldownUntil = now + 86_400_000;
				} else {
					candidate.cooldownUntil = now + FAILED_PROFILE_COOLDOWN_MS;
				}
				errors.push(`${candidate.id}: ${errMsg}`);
			}
		}
		throw new Error(
			`No healthy Claude OAuth profile is available${errors.length ? ` (${errors.join("; ")})` : ""}`,
		);
	}

	public async healthCheck(): Promise<TokenHealth[]> {
		await this.ensurePoolLoaded();
		return Promise.all(
			this.candidatePool.map(async (candidate): Promise<TokenHealth> => {
				try {
					const healthy = await this.resolveCandidate(candidate);
					return {
						profileId: candidate.id,
						healthy: true,
						expiresAt: healthy.expiresAt,
						cooldownUntil: candidate.cooldownUntil,
					};
				} catch (error) {
					return {
						profileId: candidate.id,
						healthy: false,
						expiresAt: candidate.expiresAt,
						cooldownUntil: candidate.cooldownUntil,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
	}

	private resolveExplicitApiKey(): string | undefined {
		const env = this.options.env ?? process.env;
		const value =
			this.explicitApiKey ||
			env.ANTHROPIC_API_KEY ||
			env.CLAUDE_API_KEY;
		if (!value || value === "claude-auth" || value === "oauth")
			return undefined;
		return value.trim();
	}

	private resolveExplicitOAuthToken(): string | undefined {
		const env = this.options.env ?? process.env;
		const value =
			this.explicitOAuthToken ||
			env.CLAUDE_CODE_OAUTH_TOKEN ||
			env.ANTHROPIC_OAUTH_TOKEN;
		return value?.trim() || undefined;
	}
	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private async ensurePoolLoaded(): Promise<void> {
		if (!this.poolLoadPromise)
			this.poolLoadPromise = Promise.resolve().then(() =>
				this.loadCandidates(),
			);
		await this.poolLoadPromise;
	}

	private loadCandidates(): void {
		const candidates: OAuthCandidate[] = [];
		const seen = new Set<string>();
		const add = (candidate: OAuthCandidate) => {
			const identity =
				candidate.accountUuid ||
				candidate.refreshToken ||
				candidate.accessToken;
			if (!identity || seen.has(identity)) return;
			seen.add(identity);
			candidates.push(candidate);
		};

		const claudeRoot = readJsonFile(this.claudeCredentialsFilePath);
		const claudeOauth = readStoredOAuth(claudeRoot?.claudeAiOauth);
		if (claudeOauth) add(this.toCandidate("claude", 0, claudeOauth));

		const piRoot = readJsonFile(this.authFilePath);
		const piEntries = Array.isArray(piRoot?.anthropic)
			? piRoot.anthropic
			: [piRoot?.anthropic];
		piEntries.forEach((entry, index) => {
			const oauth = readStoredOAuth(entry);
			if (oauth && oauth.type !== "api_key")
				add(this.toCandidate("pi", index, oauth));
		});

		this.scanKeychainServices().forEach((service, index) => {
			const raw = this.readKeychainService(service);
			if (!raw) return;
			try {
				const parsed: unknown = JSON.parse(raw);
				const root = isRecord(parsed) ? parsed : undefined;
				const oauth = readStoredOAuth(root?.claudeAiOauth);
				if (oauth) add(this.toCandidate("keychain", index, oauth, service));
			} catch {
				// Raw API keys are intentionally not pooled with OAuth profiles.
			}
		});
		const now = this.now();
		candidates.sort((a, b) => {
			const aValid = a.accessToken && a.expiresAt - now > TOKEN_REFRESH_SKEW_MS ? 1 : 0;
			const bValid = b.accessToken && b.expiresAt - now > TOKEN_REFRESH_SKEW_MS ? 1 : 0;
			if (aValid !== bValid) return bValid - aValid;
			const sourcePriority = { claude: 3, pi: 2, keychain: 1 };
			return (sourcePriority[b.source] ?? 0) - (sourcePriority[a.source] ?? 0);
		});
		this.candidatePool = candidates;
	}

	private toCandidate(
		source: OAuthCandidate["source"],
		sourceIndex: number,
		stored: StoredOAuthShape,
		service?: string,
	): OAuthCandidate {
		const accountUuid = stored.accountUuid ?? stored.accountId;
		return {
			id: `${source}:${service ?? accountUuid ?? sourceIndex}`,
			source,
			sourceIndex,
			accessToken: stored.accessToken ?? stored.access,
			refreshToken: stored.refreshToken ?? stored.refresh,
			expiresAt: stored.expiresAt ?? stored.expires ?? 0,
			accountUuid,
			cooldownUntil: 0,
		};
	}

	private async resolveCandidate(
		candidate: OAuthCandidate,
	): Promise<OAuthCandidate> {
		if (
			candidate.accessToken &&
			candidate.expiresAt - this.now() > TOKEN_REFRESH_SKEW_MS
		)
			return candidate;
		if (!candidate.refreshToken)
			throw new Error("profile has no refresh token");
		const existing = this.refreshPromises.get(candidate.id);
		if (existing) return existing;
		const refresh = this.refreshCandidate(candidate);
		this.refreshPromises.set(candidate.id, refresh);
		try {
			return await refresh;
		} finally {
			this.refreshPromises.delete(candidate.id);
		}
	}

	private async refreshCandidate(
		candidate: OAuthCandidate,
	): Promise<OAuthCandidate> {
		const refreshToken = candidate.refreshToken;
		if (!refreshToken) throw new Error("profile has no refresh token");
		const bundle = await this.refreshOAuthToken(refreshToken);
		candidate.accessToken = bundle.access_token;
		candidate.refreshToken = bundle.refresh_token ?? candidate.refreshToken;
		candidate.expiresAt = bundle.expires_at ?? this.now() + 28_800_000;
		candidate.cooldownUntil = 0;
		await this.queuePersist(candidate);
		return candidate;
	}

	private queuePersist(candidate: OAuthCandidate): Promise<void> {
		const pending = this.persistPromise.then(() =>
			this.persistCandidate(candidate),
		);
		this.persistPromise = pending.catch(() => undefined);
		return pending;
	}

	private persistCandidate(candidate: OAuthCandidate): void {
		if (!candidate.accessToken) return;
		if (candidate.source === "claude") {
			const root = readJsonFile(this.claudeCredentialsFilePath) ?? {};
			const current = isRecord(root.claudeAiOauth) ? root.claudeAiOauth : {};
			root.claudeAiOauth = {
				...current,
				accessToken: candidate.accessToken,
				refreshToken: candidate.refreshToken,
				expiresAt: candidate.expiresAt,
			};
			writeJsonAtomically(this.claudeCredentialsFilePath, root);
			return;
		}
		if (candidate.source !== "pi") return;
		const root = readJsonFile(this.authFilePath) ?? {};
		const stored = root.anthropic;
		const replacement = {
			type: "oauth",
			access: candidate.accessToken,
			refresh: candidate.refreshToken,
			expires: candidate.expiresAt,
			accountId: candidate.accountUuid,
		};
		if (Array.isArray(stored)) {
			const next = [...stored];
			next[candidate.sourceIndex] = {
				...(isRecord(next[candidate.sourceIndex])
					? next[candidate.sourceIndex]
					: {}),
				...replacement,
			};
			root.anthropic = next;
		} else {
			root.anthropic = { ...(isRecord(stored) ? stored : {}), ...replacement };
		}
		writeJsonAtomically(this.authFilePath, root);
	}

	private scanKeychainServices(): string[] {
		if (this.options.keychainServices) return this.options.keychainServices();
		if (process.platform !== "darwin") return [];
		const now = this.now();
		if (this.cachedKeychainServices && this.cachedKeychainServices.expiresAt > now) {
			return this.cachedKeychainServices.services;
		}
		try {
			const result = spawnSync("security", ["dump-keychain"], {
				encoding: "utf8",
				timeout: 4000,
			});
			if (result.status !== 0 || !result.stdout) {
				this.cachedKeychainServices = { services: [], expiresAt: now + 30_000 };
				return [];
			}
			const matches =
				result.stdout.match(/Claude Code-credentials-[a-f0-9]+/g) || [];
			const services = Array.from(new Set(matches));
			this.cachedKeychainServices = { services, expiresAt: now + 60_000 };
			return services;
		} catch {
			this.cachedKeychainServices = { services: [], expiresAt: now + 30_000 };
			return [];
		}
	}

	private readKeychainService(service: string): string | undefined {
		if (this.options.keychainReader)
			return this.options.keychainReader(service);
		if (process.platform !== "darwin") return undefined;
		const now = this.now();
		const cached = this.cachedKeychainValues.get(service);
		if (cached && cached.expiresAt > now) return cached.value;
		try {
			const result = spawnSync(
				"security",
				["find-generic-password", "-s", service, "-w"],
				{ encoding: "utf8", timeout: 4000 },
			);
			if (result.status !== 0) {
				this.cachedKeychainValues.set(service, { value: undefined, expiresAt: now + 30_000 });
				return undefined;
			}
			let raw = (result.stdout || "").trim();
			if (/^[0-9a-fA-F]{10,}$/.test(raw)) {
				const decoded = Buffer.from(raw, "hex").toString("utf8");
				if (decoded.startsWith("{") || decoded.startsWith("sk-")) raw = decoded;
			}
			this.cachedKeychainValues.set(service, { value: raw, expiresAt: now + 300_000 });
			return raw;
		} catch {
			this.cachedKeychainValues.set(service, { value: undefined, expiresAt: now + 30_000 });
			return undefined;
		}
	}

	public async refreshOAuthToken(
		refreshToken: string,
	): Promise<ClaudeTokenBundle> {
		if (this.options.refreshOAuthToken)
			return this.options.refreshOAuthToken(refreshToken);
		const clientId = Buffer.from(OAUTH_CLIENT_ID, "base64").toString("utf8");
		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: clientId,
				refresh_token: refreshToken,
			}),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Anthropic OAuth token refresh failed (${response.status}): ${errorText}`,
			);
		}
		const data: unknown = await response.json();
		if (!isRecord(data) || typeof data.access_token !== "string") {
			throw new Error(
				"Anthropic OAuth token refresh returned an invalid payload",
			);
		}
		return {
			access_token: data.access_token,
			refresh_token:
				typeof data.refresh_token === "string"
					? data.refresh_token
					: refreshToken,
			token_type:
				typeof data.token_type === "string" ? data.token_type : undefined,
			expires_at:
				this.now() +
				(typeof data.expires_in === "number" ? data.expires_in : 28_800) *
					1000 -
				5 * 60 * 1000,
		};
	}

	public static async generatePKCE(): Promise<{
		verifier: string;
		challenge: string;
	}> {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		const verifier = btoa(String.fromCharCode(...array))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const hash = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier),
		);
		const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		return { verifier, challenge };
	}

	public static getAuthorizeUrl(challenge: string, state: string): string {
		const clientId = Buffer.from(OAUTH_CLIENT_ID, "base64").toString("utf8");
		const params = new URLSearchParams({
			code: "true",
			client_id: clientId,
			response_type: "code",
			redirect_uri: "https://console.anthropic.com/oauth/code/callback",
			scope:
				"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		});
		return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
	}

	public static async exchangeAuthCode(
		authCode: string,
		verifier: string,
	): Promise<ClaudeTokenBundle> {
		const clientId = Buffer.from(OAUTH_CLIENT_ID, "base64").toString("utf8");
		const [code, state] = authCode.trim().split("#");
		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: clientId,
				code,
				state,
				redirect_uri: "https://console.anthropic.com/oauth/code/callback",
				code_verifier: verifier,
			}),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Anthropic authorization code exchange failed: ${errorText}`,
			);
		}
		const data: unknown = await response.json();
		if (!isRecord(data) || typeof data.access_token !== "string") {
			throw new Error(
				"Anthropic authorization code exchange returned an invalid payload",
			);
		}
		return {
			access_token: data.access_token,
			refresh_token:
				typeof data.refresh_token === "string" ? data.refresh_token : undefined,
			token_type:
				typeof data.token_type === "string" ? data.token_type : undefined,
			expires_at:
				Date.now() +
				(typeof data.expires_in === "number" ? data.expires_in : 28_800) *
					1000 -
				5 * 60 * 1000,
		};
	}
}
