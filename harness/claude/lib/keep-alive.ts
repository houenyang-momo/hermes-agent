#!/usr/bin/env bun
/**
 * Claude OAuth Token Background Keeper.
 *
 * Runs periodically to ensure OAuth tokens never expire by proactively
 * refreshing before the rolling expiration window closes.
 */

import { TokenStore } from "./token-store.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_FILE = path.join(os.homedir(), ".claude", "keep-alive.log");

function log(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	fs.appendFileSync(LOG_FILE, line);
	console.log(line.trim());
}

async function keepAlive() {
	try {
		const store = new TokenStore();
		const creds = store.readClaudeCredentialsFile();
		const oauth = creds?.claudeAiOauth;

		if (!oauth || !oauth.refreshToken) {
			log("⚠️ No active Claude OAuth session or refresh token found. Manual login needed.");
			return;
		}

		const expiresAt = oauth.expiresAt || 0;
		const now = Date.now();
		const remainingMs = expiresAt - now;
		const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);

		// Refresh if less than 4 hours remaining (or if expired)
		if (remainingMs < 4 * 60 * 60 * 1000) {
			log(`Token expiring in ${remainingHours}h. Proactively refreshing...`);
			const fresh = await store.refreshOAuthToken(oauth.refreshToken);
			store.persistToAllStores(fresh);
			const newExpiry = new Date(fresh.expires_at || Date.now() + 28800000).toISOString();
			log(`✅ Token successfully refreshed! New expiry: ${newExpiry}`);
		} else {
			log(`Token is healthy (${remainingHours}h remaining). No refresh needed.`);
		}
	} catch (err: any) {
		log(`❌ Keep-alive error: ${err?.message || String(err)}`);
	}
}

keepAlive().catch((err) => {
	log(`❌ Fatal keep-alive crash: ${err?.message || String(err)}`);
});
