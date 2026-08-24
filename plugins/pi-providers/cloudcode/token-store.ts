import { spawnSync } from "node:child_process";
import type { KeychainPayload, TokenBundle } from "./types.js";

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYCHAIN_PREFIX = "go-keyring-base64:";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_CLIENT_ID =
	process.env.CLOUDCODE_CLIENT_ID ||
	process.env.GOOGLE_CLIENT_ID ||
	Buffer.from("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==", "base64").toString("utf8");
const DEFAULT_CLIENT_SECRET =
	process.env.CLOUDCODE_CLIENT_SECRET ||
	process.env.GOOGLE_CLIENT_SECRET ||
	Buffer.from("R0NDU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8").replace("GCCSPX", "GOCSPX");
const TOKEN_REFRESH_SKEW_MS = 120_000;

export class TokenStore {
	private cachedAccessToken?: string;
	private cachedRefreshToken?: string;
	private cachedTokenExpiryMs = 0;
	private cachedProjectId?: string;
	private refreshPromise?: Promise<string>;
	private forceRefresh = false;
	constructor(
		private clientId: string = DEFAULT_CLIENT_ID,
		private clientSecret: string = DEFAULT_CLIENT_SECRET,
	) {}

	public hasSession(): boolean {
		if (this.cachedAccessToken || this.cachedRefreshToken) return true;
		if (process.env.CLOUDCODE_ACCESS_TOKEN || process.env.ANTIGRAVITY_TOKEN) return true;
		return Boolean(this.readKeychainRaw());
	}

	public getCachedProjectId(): string | undefined {
		return this.cachedProjectId;
	}

	public setCachedProjectId(projectId: string): void {
		this.cachedProjectId = projectId;
	}

	public invalidateProjectId(): void {
		this.cachedProjectId = undefined;
	}

	public invalidateToken(): void {
		this.cachedAccessToken = undefined;
		this.cachedTokenExpiryMs = 0;
		this.forceRefresh = true;
		delete process.env.CLOUDCODE_ACCESS_TOKEN;
		delete process.env.ANTIGRAVITY_TOKEN;
	}

	public getRemainingMinutes(): number {
		if (this.cachedTokenExpiryMs <= 0) return 0;
		return Math.max(0, Math.round((this.cachedTokenExpiryMs - Date.now()) / 60000));
	}

	public async getAccessToken(): Promise<string> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = this.resolveAccessTokenInternal();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = undefined;
		}
	}

	private async resolveAccessTokenInternal(): Promise<string> {
		const envToken = process.env.CLOUDCODE_ACCESS_TOKEN || process.env.ANTIGRAVITY_TOKEN;
		if (envToken) {
			this.cachedAccessToken = envToken;
			this.cachedTokenExpiryMs = Date.now() + 3600_000;
			return envToken;
		}

		const now = Date.now();

		// 1. Fast in-memory path (zero OS process execution)
		if (this.cachedAccessToken && this.cachedTokenExpiryMs - now > TOKEN_REFRESH_SKEW_MS) {
			return this.cachedAccessToken;
		}

		// 2. In-memory token refresh via HTTPS
		if (this.cachedRefreshToken && this.cachedTokenExpiryMs > 0 && this.cachedTokenExpiryMs - now <= TOKEN_REFRESH_SKEW_MS) {
			try {
				const next = await this.refreshAccessToken(this.cachedRefreshToken);
				this.updateInMemory(next);
				this.persistToKeychain(next);
				return next.access_token;
			} catch {
				// Fall back to reading keychain fresh
			}
		}

		// 3. Keychain read path
		const raw = this.readKeychainRaw();
		if (!raw) {
			throw new Error("Antigravity is not logged in. Run `agy` in a terminal to sign in with Google, then /reload.");
		}

		const stored = this.parseKeychain(raw);
		const expiry = this.parseExpiry(stored.token.expiry);
		this.cachedRefreshToken = stored.token.refresh_token;

		if (!this.forceRefresh && stored.token.access_token && expiry - now > TOKEN_REFRESH_SKEW_MS) {
			this.cachedAccessToken = stored.token.access_token;
			this.cachedTokenExpiryMs = expiry;
			return stored.token.access_token;
		}

		if (!stored.token.refresh_token) {
			throw new Error("Antigravity refresh token missing. Run `agy` to sign in again.");
		}

		const next = await this.refreshAccessToken(stored.token.refresh_token);
		this.updateInMemory(next);
		stored.token = next;
		this.writeKeychain(stored);
		this.forceRefresh = false;
		return next.access_token;
	}

	private updateInMemory(next: TokenBundle): void {
		this.cachedAccessToken = next.access_token;
		this.cachedRefreshToken = next.refresh_token || this.cachedRefreshToken;
		this.cachedTokenExpiryMs = this.parseExpiry(next.expiry);
	}

	private persistToKeychain(next: TokenBundle): void {
		const raw = this.readKeychainRaw();
		if (raw) {
			try {
				const stored = this.parseKeychain(raw);
				stored.token = next;
				this.writeKeychain(stored);
			} catch {
				// Ignore write failures on stale keychain
			}
		}
	}
	private getTokenFilePath(): string {
		return process.env.ANTIGRAVITY_TOKEN_FILE || `${process.env.HOME || "/root"}/.config/antigravity/tokens.json`;
	}

	private readKeychainRaw(): string | undefined {
		if (process.platform === "darwin") {
			try {
				const result = spawnSync(
					"security",
					["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
					{ encoding: "utf8", timeout: 4000 },
				);
				if (result.status === 0 && result.stdout) {
					return result.stdout.trim();
				}
			} catch {
				// Fall through to file check
			}
		}

		// Headless Linux / container file fallback
		try {
			const tokenPath = this.getTokenFilePath();
			const fs = require("node:fs");
			if (fs.existsSync(tokenPath)) {
				return fs.readFileSync(tokenPath, "utf8").trim();
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private parseKeychain(raw: string): KeychainPayload {
		if (raw.startsWith(KEYCHAIN_PREFIX)) {
			const decoded = Buffer.from(raw.slice(KEYCHAIN_PREFIX.length), "base64").toString("utf8");
			const data = JSON.parse(decoded) as KeychainPayload;
			if (!data?.token?.refresh_token && !data?.token?.access_token) {
				throw new Error("Antigravity token is empty.");
			}
			return data;
		}

		if (raw.startsWith("{")) {
			const data = JSON.parse(raw) as any;
			if (data?.token?.access_token || data?.token?.refresh_token) {
				return data as KeychainPayload;
			}
			if (data?.access_token || data?.refresh_token) {
				return { token: data } as KeychainPayload;
			}
		}

		throw new Error("Antigravity token item format invalid.");
	}

	private writeKeychain(payload: KeychainPayload): void {
		if (process.platform === "darwin") {
			const wrapped = KEYCHAIN_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
			const result = spawnSync(
				"security",
				["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", wrapped],
				{ encoding: "utf8", timeout: 4000 },
			);
			if (result.status === 0) return;
		}

		// Headless Linux / container file write
		try {
			const tokenPath = this.getTokenFilePath();
			const fs = require("node:fs");
			const path = require("node:path");
			fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2), { mode: 0o600, encoding: "utf8" });
		} catch (err: any) {
			throw new Error(`Could not update Antigravity token file: ${err?.message || String(err)}`);
		}
	}
	private parseExpiry(raw: string | undefined): number {
		if (!raw) return 0;
		let s = raw.trim();
		if (s.includes(".")) {
			const [head, tail0] = s.split(".", 2);
			let tail = tail0;
			let tz = "";
			for (let i = 0; i < tail.length; i++) {
				if (tail[i] === "Z" || tail[i] === "+" || tail[i] === "-") {
					tz = tail.slice(i);
					tail = tail.slice(0, i);
					break;
				}
			}
			s = `${head}.${tail.slice(0, 6)}${tz}`;
		}
		const ms = Date.parse(s);
		return Number.isFinite(ms) ? ms : 0;
	}

	private async refreshAccessToken(refreshToken: string): Promise<TokenBundle> {
		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			throw new Error(`Antigravity OAuth refresh failed (HTTP ${response.status}). Run \`agy\` to sign in again. ${detail}`);
		}
		const payload = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			token_type?: string;
			expires_in?: number;
		};
		if (!payload.access_token) {
			throw new Error("Antigravity OAuth refresh returned no access token. Run `agy` to sign in again.");
		}
		const expiry = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString();
		return {
			access_token: payload.access_token,
			refresh_token: payload.refresh_token || refreshToken,
			token_type: payload.token_type || "Bearer",
			expiry,
		};
	}
}
