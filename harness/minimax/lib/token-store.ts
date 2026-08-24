/**
 * Token store and credential resolver for MiniMax (OAuth & API Key).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

export class MiniMaxTokenStore {
	private explicitApiKey?: string;
	private cachedApiKey?: string;
	private cachedMode: "oauth" | "api-key" | "none" = "none";

	constructor(explicitApiKey?: string) {
		this.explicitApiKey = explicitApiKey;
	}

	public getApiKey(): string | undefined {
		if (this.explicitApiKey) {
			this.cachedMode = "api-key";
			return this.explicitApiKey;
		}

		// 1. Environment variables
		if (process.env.MINIMAX_OAUTH_TOKEN) {
			this.cachedMode = "oauth";
			return process.env.MINIMAX_OAUTH_TOKEN;
		}
		if (process.env.MINIMAX_BEARER_TOKEN) {
			this.cachedMode = "oauth";
			return process.env.MINIMAX_BEARER_TOKEN;
		}
		if (process.env.MINIMAX_API_KEY) {
			this.cachedMode = "api-key";
			return process.env.MINIMAX_API_KEY;
		}
		if (process.env.MINIMAXI_API_KEY) {
			this.cachedMode = "api-key";
			return process.env.MINIMAXI_API_KEY;
		}
		if (process.env.MINIMAX_TOKEN_PLAN_API_KEY) {
			this.cachedMode = "api-key";
			return process.env.MINIMAX_TOKEN_PLAN_API_KEY;
		}

		if (this.cachedApiKey) return this.cachedApiKey;

		// 2. ~/.pi/agent/auth.json
		try {
			const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			if (fs.existsSync(authPath)) {
				const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
				if (data["minimax-oauth"]?.access || data["minimax-oauth"]?.token || data["minimax-oauth"]?.access_token) {
					this.cachedApiKey = data["minimax-oauth"].access || data["minimax-oauth"].token || data["minimax-oauth"].access_token;
					this.cachedMode = "oauth";
					return this.cachedApiKey;
				}
				if (data.minimax?.access || data.minimax?.token || data.minimax?.apiKey) {
					this.cachedApiKey = data.minimax.access || data.minimax.token || data.minimax.apiKey;
					this.cachedMode = (data.minimax?.access || data.minimax?.token) ? "oauth" : "api-key";
					return this.cachedApiKey;
				}
				if (typeof data.minimax === "string") {
					this.cachedApiKey = data.minimax;
					this.cachedMode = "api-key";
					return this.cachedApiKey;
				}
			}
		} catch {
			// ignore read error
		}

		// 3. ~/.hermes/auth.json (Hermes OAuth bridge)
		try {
			const hermesAuthPath = path.join(os.homedir(), ".hermes", "auth.json");
			if (fs.existsSync(hermesAuthPath)) {
				const data = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8"));
				const oauthEntry = data.providers?.["minimax-oauth"] || data["minimax-oauth"]?.[0];
				if (oauthEntry?.access_token || oauthEntry?.access) {
					this.cachedApiKey = oauthEntry.access_token || oauthEntry.access;
					this.cachedMode = "oauth";
					return this.cachedApiKey;
				}
			}
		} catch {
			// ignore read error
		}

		// 3. Codex-router token plan file
		try {
			const secretPath = path.join(os.homedir(), ".local", "share", "codex-router", "config", "minimax", "minimax-token-plan-key.secret");
			if (fs.existsSync(secretPath)) {
				const content = fs.readFileSync(secretPath, "utf8").trim();
				if (content) {
					this.cachedApiKey = content;
					this.cachedMode = "api-key";
					return this.cachedApiKey;
				}
			}
		} catch {}

		// 4. macOS Keychain lookup with 4s bounded timeout
		try {
			const res = spawnSync(
				"security",
				["find-generic-password", "-s", "minimax-oauth", "-w"],
				{ encoding: "utf8", timeout: 4000 },
			);
			if (res.status === 0 && res.stdout?.trim()) {
				this.cachedApiKey = res.stdout.trim();
				this.cachedMode = "oauth";
				return this.cachedApiKey;
			}
		} catch {}

		return undefined;
	}

	public hasSession(): boolean {
		return Boolean(this.getApiKey());
	}

	public getAuthMode(): "oauth" | "api-key" | "none" {
		this.getApiKey();
		return this.cachedMode;
	}
}
