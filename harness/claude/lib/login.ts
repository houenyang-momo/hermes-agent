#!/usr/bin/env bun
/**
 * Interactive Anthropic OAuth Login Helper for Pi Agent.
 *
 * Direct CLI flow without local callback port conflicts:
 * 1. Generates PKCE pair and state
 * 2. Opens browser authorization URL
 * 3. Accepts pasted code / redirect URL from user
 * 4. Exchanges code for token & saves to ~/.pi/agent/auth.json and ~/.claude/.credentials.json
 */

import * as readline from "node:readline";
import { TokenStore } from "./token-store.js";
import * as fs from "node:fs";
import * as path from "node:path";

const OAUTH_CLIENT_ID = "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl";
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

function ask(query: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans.trim());
		});
	});
}

async function main() {
	console.log("==================================================================");
	console.log("🔑 Claude & Fable Enterprise OAuth Sign-in");
	console.log("==================================================================\n");

	const { verifier, challenge } = await TokenStore.generatePKCE();
	const clientId = Buffer.from(OAUTH_CLIENT_ID, "base64").toString("utf8");

	const params = new URLSearchParams({
		code: "true",
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	const authUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;

	console.log("Step 1: Make sure you are logged in to your Enterprise (EBU Claude) account on claude.ai in your browser.");
	console.log("\nStep 2: Open this authorization link in your browser:\n");
	console.log(`\x1b[36m${authUrl}\x1b[0m\n`);
	console.log("Step 3: Click Authorize (make sure your Enterprise workspace is selected).");
	console.log("Step 4: After authorizing, the browser will redirect or display a code string (e.g. `code#state` or URL containing `code=...`).\n");

	const input = await ask("👉 Paste the code (or the full redirected URL) here: ");

	if (!input) {
		console.log("❌ Login cancelled.");
		process.exit(1);
	}

	let code = input;
	let state = verifier;

	if (input.includes("code=")) {
		try {
			const url = new URL(input);
			code = url.searchParams.get("code") || code;
			state = url.searchParams.get("state") || state;
		} catch {
			const m = input.match(/code=([^&#]+)/);
			if (m) code = m[1];
		}
	} else if (input.includes("#")) {
		const parts = input.split("#");
		code = parts[0];
		state = parts[1] || verifier;
	}

	console.log("\nExchanging authorization code with Anthropic...");

	const response = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		console.error(`\n❌ Token exchange failed (${response.status}): ${err}`);
		process.exit(1);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		token_type?: string;
	};

	const home = process.env.HOME || "";
	const piPath = path.join(home, ".pi", "agent", "auth.json");
	let piAuth: Record<string, any> = {};
	try {
		if (fs.existsSync(piPath)) piAuth = JSON.parse(fs.readFileSync(piPath, "utf8"));
	} catch {}

	const expiresAt = Date.now() + (data.expires_in ?? 28800) * 1000 - 5 * 60 * 1000;

	piAuth.anthropic = {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: expiresAt,
	};

	fs.mkdirSync(path.dirname(piPath), { recursive: true });
	fs.writeFileSync(piPath, JSON.stringify(piAuth, null, 2), { mode: 0o600 });

	// Also update ~/.claude/.credentials.json
	const claudePath = path.join(home, ".claude", ".credentials.json");
	let creds: Record<string, any> = {};
	try {
		if (fs.existsSync(claudePath)) creds = JSON.parse(fs.readFileSync(claudePath, "utf8"));
	} catch {}
	if (!creds.claudeAiOauth) creds.claudeAiOauth = {};
	creds.claudeAiOauth.accessToken = data.access_token;
	if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
	creds.claudeAiOauth.expiresAt = expiresAt;

	fs.mkdirSync(path.dirname(claudePath), { recursive: true });
	fs.writeFileSync(claudePath, JSON.stringify(creds, null, 2), { mode: 0o600 });

	console.log("\n==================================================================");
	console.log("✅ Successfully signed in to Claude Enterprise!");
	console.log(`   Saved fresh credentials to: ${piPath}`);
	console.log(`   Token valid for: ${Math.round((expiresAt - Date.now()) / 60000)} minutes (~8 hours)`);
	console.log("==================================================================\n");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
