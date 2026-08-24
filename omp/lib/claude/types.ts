import type {
	AssistantMessageEvent,
	Context,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/**
 * Type definitions for Claude / Fable / Anthropic client.
 */

export interface ClaudeTokenBundle {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	expires_at?: number;
}

export interface ClaudeModelSpec {
	id: string;
	name: string;
	backend: string;
	effort:
		| "off"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "ultracode";
	maxTokens: number;
	contextWindow: number;
	thinkingBudgetTokens?: number;
	supportsAdaptiveThinking?: boolean;
	supportsStrictTools?: boolean;
	supportsEffort?: boolean;
}

export interface ClaudeClientStatus {
	connected: boolean;
	authMode: "oauth" | "api-key" | "none";
	tokenRemainingMinutes?: number;
	endpoint: string;
	defaultModel: string;
	error?: string;
}

export interface ClaudeClientConfig {
	host?: string;
	apiKey?: string;
	oauthToken?: string;
	userAgent?: string;
	clientMetadata?: Record<string, unknown>;
	fallbackStreamFactory?: (
		context: Context,
		options?: SimpleStreamOptions,
	) => AsyncIterable<AssistantMessageEvent>;
	quotaCooldownMs?: number;
}

export interface ResolvedAuth {
	token: string;
	mode: "oauth" | "api-key";
	profileId?: string;
	accountUuid?: string;
	expiresAt?: number;
}
