/**
 * Type definitions for Cloud Code / Antigravity Gemini client.
 */

export interface TokenBundle {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expiry: string;
}

export interface KeychainPayload {
	auth_method?: string;
	token: TokenBundle;
}

export interface CloudCodeModelSpec {
	id: string;
	name: string;
	backend: string;
	effort: "low" | "medium" | "high";
	maxTokens: number;
}

export interface CloudCodeStatus {
	connected: boolean;
	project?: string;
	tokenRemainingMinutes?: number;
	endpoint: string;
	defaultModel: string;
	error?: string;
}

export interface CloudCodeClientConfig {
	host?: string;
	clientId?: string;
	clientSecret?: string;
	userAgent?: string;
	clientMetadata?: Record<string, unknown>;
}
