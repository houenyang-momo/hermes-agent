/**
 * Type definitions for MiniMax M3 client.
 */

export interface MiniMaxModelSpec {
	id: string;
	name: string;
	backend: string;
	effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTokens: number;
	contextWindow: number;
	supportsReasoning?: boolean;
	supportsTools?: boolean;
}

export interface MiniMaxClientStatus {
	connected: boolean;
	authMode: "api-key" | "none";
	endpoint: string;
	defaultModel: string;
	error?: string;
}

export interface MiniMaxClientConfig {
	host?: string;
	apiKey?: string;
	groupId?: string;
}
