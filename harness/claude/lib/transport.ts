import { StreamTransport } from "../common/stream-transport.js";
import type { TokenStore } from "./token-store.js";
import type { ResolvedAuth } from "./types.js";

const DEFAULT_USER_AGENT = "claude-cli/2.1.234 (external, sdk-cli)";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_ANTHROPIC_BETAS =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11";
const APIKEY_ANTHROPIC_BETAS =
	"prompt-caching-2024-07-31,output-128k-2025-02-19";

interface ClaudeStreamUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	output_tokens_details?: { thinking_tokens?: number };
}

interface ClaudeStreamEvent extends Record<string, unknown> {
	type?: string;
	message?: { id?: string; usage?: ClaudeStreamUsage };
	content_block?: {
		type?: string;
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
	};
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		signature?: string;
		partial_json?: string;
		stop_reason?: string;
	};
	usage?: ClaudeStreamUsage;
}

export class ClaudeTransport {
	private streamTransport: StreamTransport;

	constructor(
		private host: string,
		private userAgent: string = DEFAULT_USER_AGENT,
		private tokenStore: TokenStore,
	) {
		this.streamTransport = new StreamTransport({
			host: this.host,
			inactivityTimeoutMs: 45_000,
			requestTimeoutMs: 120_000,
			maxRetries: 3,
		});
	}

	public headers(
		auth: ResolvedAuth,
		sessionId?: string,
		attempt = 0,
	): Record<string, string> {
		const h: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			"anthropic-version": ANTHROPIC_VERSION,
			"User-Agent": this.userAgent,
		};

		if (auth.mode === "api-key") {
			h["x-api-key"] = auth.token;
			h["anthropic-beta"] = APIKEY_ANTHROPIC_BETAS;
		} else {
			h.Authorization = `Bearer ${auth.token}`;
			h["anthropic-beta"] = OAUTH_ANTHROPIC_BETAS;
			h["anthropic-dangerous-direct-browser-access"] = "true";
			h["x-app"] = "cli";
			h["x-claude-code-session-id"] =
				sessionId || "c171eae2-5b11-4bc6-be8a-362be566a4ea";
			h["x-client-request-id"] = crypto.randomUUID();
			h["x-stainless-arch"] = "arm64";
			h["x-stainless-lang"] = "js";
			h["x-stainless-os"] = "MacOS";
			h["x-stainless-package-version"] = "0.112.1";
			h["x-stainless-retry-count"] = String(attempt);
			h["x-stainless-runtime"] = "node";
			h["x-stainless-runtime-version"] = "v26.3.0";
			h["x-stainless-timeout"] = "600";
		}

		return h;
	}

	public async postWithRetry(
		path: string,
		auth: ResolvedAuth,
		body: unknown,
		signal?: AbortSignal,
		attempt = 0,
		sessionId?: string,
	): Promise<Response> {
		const reqHeaders = this.headers(auth, sessionId, attempt);
		return this.streamTransport.postWithRetry(path, reqHeaders, body, {
			signal,
			attempt,
			retryRateLimits: false,
			on401Retry: async () => {
				this.tokenStore.invalidateToken(auth);
				const freshAuth = await this.tokenStore.getAuth();
				return this.headers(freshAuth, sessionId, attempt + 1);
			},
		});
	}

	public async *readSse(
		response: Response,
		signal?: AbortSignal,
		inactivityTimeoutMs = 45_000,
	): AsyncGenerator<ClaudeStreamEvent> {
		yield* this.streamTransport.readSse<ClaudeStreamEvent>(
			response,
			signal,
			inactivityTimeoutMs,
		);
	}

	public warm(): void {
		void this.streamTransport.warmConnection("/v1/messages");
	}
}
