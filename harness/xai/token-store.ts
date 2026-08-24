/**
 * Token store and credential resolver for xAI / Grok (OAuth & API Key).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

interface JwtPayload {
	exp?: number;
	iat?: number;
	sub?: string;
	[key: string]: unknown;
}

interface GrokAuthEntry {
	key?: string;
	refresh_token?: string;
	expires_at?: string;
	[key: string]: unknown;
}

interface HermesAuthFile {
	providers?: {
		"xai-oauth"?: {
			auth_mode?: string;
			discovery?: { token_endpoint?: string };
			last_refresh?: string;
			tokens?: {
				access_token?: string;
				refresh_token?: string;
			};
			access_token?: string;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface PiAuthFile {
	xai?: {
		type?: string;
		key?: string;
		access?: string;
	} | string;
	"xai-oauth"?: {
		type?: string;
		key?: string;
		access?: string;
	};
	[key: string]: unknown;
}

function parseJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const json = Buffer.from(payloadBase64, "base64").toString("utf8");
		return JSON.parse(json) as JwtPayload;
	} catch {
		return null;
	}
}

export class XaiTokenStore {
	private explicitApiKey?: string;
	private cachedToken?: string;
	private refreshMutex?: Promise<string | undefined>;

	constructor(explicitApiKey?: string) {
		this.explicitApiKey = explicitApiKey;
	}

	public async getAccessToken(forceRefresh = false): Promise<string | undefined> {
		if (this.explicitApiKey) {
			return this.explicitApiKey;
		}

		if (process.env.XAI_API_KEY && !forceRefresh) {
			return process.env.XAI_API_KEY;
		}

		if (this.refreshMutex) {
			return this.refreshMutex;
		}

		const token = await this.resolveToken(forceRefresh);
		if (token) {
			this.cachedToken = token;
		}
		return token;
	}

	public getSyncToken(): string | undefined {
		if (this.explicitApiKey) return this.explicitApiKey;
		if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
		if (this.cachedToken) return this.cachedToken;

		// Try fast sync read from grok auth
		try {
			const grokAuthPath = path.join(os.homedir(), ".grok", "auth.json");
			if (fs.existsSync(grokAuthPath)) {
				const grokAuth = JSON.parse(fs.readFileSync(grokAuthPath, "utf8")) as Record<string, GrokAuthEntry>;
				for (const k of Object.keys(grokAuth)) {
					const entry = grokAuth[k];
					if (entry?.key && typeof entry.key === "string" && entry.key.startsWith("eyJ")) {
						const jwt = parseJwt(entry.key);
						const nowSec = Math.floor(Date.now() / 1000);
						if (!jwt?.exp || jwt.exp > nowSec + 60) {
							return entry.key;
						}
					}
				}
			}
		} catch {}

		// Try fast sync read from hermes auth
		try {
			const hermesAuthPath = path.join(os.homedir(), ".hermes", "auth.json");
			if (fs.existsSync(hermesAuthPath)) {
				const hermesAuth = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8")) as HermesAuthFile;
				const token = hermesAuth.providers?.["xai-oauth"]?.tokens?.access_token || hermesAuth.providers?.["xai-oauth"]?.access_token;
				if (token && typeof token === "string" && token.startsWith("eyJ")) {
					const jwt = parseJwt(token);
					const nowSec = Math.floor(Date.now() / 1000);
					if (!jwt?.exp || jwt.exp > nowSec + 60) {
						return token;
					}
				}
			}
		} catch {}

		// Try fast sync read from pi auth
		try {
			const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			if (fs.existsSync(piAuthPath)) {
				const piAuth = JSON.parse(fs.readFileSync(piAuthPath, "utf8")) as PiAuthFile;
				const key = typeof piAuth.xai === "object" ? (piAuth.xai?.key || piAuth.xai?.access) : piAuth.xai;
				if (key) return key;
			}
		} catch {}

		return undefined;
	}

	private async resolveToken(forceRefresh: boolean): Promise<string | undefined> {
		let tokenCandidate: string | undefined;
		let refreshTokenCandidate: string | undefined;
		let grokKey: string | undefined;

		// 1. Check ~/.grok/auth.json
		try {
			const grokAuthPath = path.join(os.homedir(), ".grok", "auth.json");
			if (fs.existsSync(grokAuthPath)) {
				const grokAuth = JSON.parse(fs.readFileSync(grokAuthPath, "utf8")) as Record<string, GrokAuthEntry>;
				for (const k of Object.keys(grokAuth)) {
					const entry = grokAuth[k];
					if (entry?.key) {
						tokenCandidate = entry.key;
						grokKey = k;
					}
					if (entry?.refresh_token) {
						refreshTokenCandidate = entry.refresh_token;
					}
				}
			}
		} catch {}

		// 2. Check ~/.hermes/auth.json
		try {
			const hermesAuthPath = path.join(os.homedir(), ".hermes", "auth.json");
			if (fs.existsSync(hermesAuthPath)) {
				const hermesAuth = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8")) as HermesAuthFile;
				const prov = hermesAuth.providers?.["xai-oauth"];
				if (!tokenCandidate && prov?.tokens?.access_token) {
					tokenCandidate = prov.tokens.access_token;
				}
				if (!refreshTokenCandidate && prov?.tokens?.refresh_token) {
					refreshTokenCandidate = prov.tokens.refresh_token;
				}
			}
		} catch {}

		// 3. Check ~/.pi/agent/auth.json
		try {
			const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			if (fs.existsSync(piAuthPath)) {
				const piAuth = JSON.parse(fs.readFileSync(piAuthPath, "utf8")) as PiAuthFile;
				if (!tokenCandidate) {
					tokenCandidate = typeof piAuth.xai === "object" ? (piAuth.xai?.key || piAuth.xai?.access) : piAuth.xai;
				}
			}
		} catch {}

		// Validate tokenCandidate expiration
		let isExpired = forceRefresh;
		if (tokenCandidate) {
			const jwt = parseJwt(tokenCandidate);
			if (jwt?.exp) {
				const nowSec = Math.floor(Date.now() / 1000);
				// Expired or less than 5 minutes remaining
				if (jwt.exp - nowSec < 300) {
					isExpired = true;
				}
			}
		} else {
			isExpired = true;
		}

		if (!isExpired && tokenCandidate) {
			return tokenCandidate;
		}

		// Refresh token if available
		if (refreshTokenCandidate) {
			this.refreshMutex = this.doRefreshToken(refreshTokenCandidate, grokKey);
			try {
				const refreshed = await this.refreshMutex;
				if (refreshed) return refreshed;
			} finally {
				this.refreshMutex = undefined;
			}
		}

		return tokenCandidate;
	}

	private async doRefreshToken(refreshToken: string, grokKey?: string): Promise<string | undefined> {
		try {
			const params = new URLSearchParams();
			params.append("grant_type", "refresh_token");
			params.append("refresh_token", refreshToken);
			params.append("client_id", XAI_OAUTH_CLIENT_ID);

			const res = await fetch(XAI_TOKEN_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString(),
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				console.error(`[xAI TokenStore] Token refresh failed (${res.status}): ${errText}`);
				return undefined;
			}

			const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
			const newAccessToken = data.access_token;
			const newRefreshToken = data.refresh_token || refreshToken;
			const expiresIn = data.expires_in || 21600;

			if (!newAccessToken) {
				return undefined;
			}

			// Persist to ~/.grok/auth.json
			try {
				const grokAuthPath = path.join(os.homedir(), ".grok", "auth.json");
				if (fs.existsSync(grokAuthPath)) {
					const grokAuth = JSON.parse(fs.readFileSync(grokAuthPath, "utf8")) as Record<string, GrokAuthEntry>;
					const k = grokKey || Object.keys(grokAuth)[0];
					if (k && grokAuth[k]) {
						grokAuth[k].key = newAccessToken;
						grokAuth[k].refresh_token = newRefreshToken;
						grokAuth[k].expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();
						fs.writeFileSync(grokAuthPath, JSON.stringify(grokAuth, null, 2), "utf8");
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[xAI TokenStore] Failed to update ~/.grok/auth.json:", msg);
			}

			// Persist to ~/.hermes/auth.json
			try {
				const hermesAuthPath = path.join(os.homedir(), ".hermes", "auth.json");
				if (fs.existsSync(hermesAuthPath)) {
					const hermesAuth = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8")) as HermesAuthFile;
					if (!hermesAuth.providers) hermesAuth.providers = {};
					if (!hermesAuth.providers["xai-oauth"]) {
						hermesAuth.providers["xai-oauth"] = {
							auth_mode: "oauth_device_code",
							discovery: { token_endpoint: XAI_TOKEN_ENDPOINT },
							tokens: {},
						};
					}
					hermesAuth.providers["xai-oauth"].last_refresh = new Date().toISOString();
					hermesAuth.providers["xai-oauth"].tokens = {
						access_token: newAccessToken,
						refresh_token: newRefreshToken,
					};
					fs.writeFileSync(hermesAuthPath, JSON.stringify(hermesAuth, null, 2), "utf8");
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[xAI TokenStore] Failed to update ~/.hermes/auth.json:", msg);
			}

			// Persist to ~/.pi/agent/auth.json
			try {
				const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
				if (fs.existsSync(piAuthPath)) {
					const piAuth = JSON.parse(fs.readFileSync(piAuthPath, "utf8")) as PiAuthFile;
					piAuth.xai = {
						type: "api_key",
						key: newAccessToken,
					};
					piAuth["xai-oauth"] = {
						type: "oauth",
						key: newAccessToken,
						access: newAccessToken,
					};
					fs.writeFileSync(piAuthPath, JSON.stringify(piAuth, null, 2), "utf8");
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[xAI TokenStore] Failed to update ~/.pi/agent/auth.json:", msg);
			}

			// Persist to ~/.pi/agent/models.json
			try {
				const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
				if (fs.existsSync(modelsPath)) {
					const models = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as { providers?: Record<string, { apiKey?: string }> };
					if (models.providers?.xai) {
						models.providers.xai.apiKey = newAccessToken;
						fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), "utf8");
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[xAI TokenStore] Failed to update ~/.pi/agent/models.json:", msg);
			}

			return newAccessToken;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[xAI TokenStore] OAuth token refresh exception:", msg);
			return undefined;
		}
	}
}

export const defaultXaiTokenStore = new XaiTokenStore();
