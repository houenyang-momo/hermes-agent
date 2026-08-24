import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { ProviderQuotaStore } from "../common/quota-store.js";
import { streamSolUltraFallback } from "../common/sol-ultra-fallback.js";
import { parseRetryAfterMs } from "../common/stream-transport.js";
import { isRecord } from "../common/value-guards.js";
import { ClaudeConversationBuilder } from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import { ClaudeTransport } from "./transport.js";
import type {
	ClaudeClientConfig,
	ClaudeClientStatus,
	ClaudeModelSpec,
} from "./types.js";

const DEFAULT_HOST = "https://api.anthropic.com";

export interface ClaudeQuotaSnapshot {
	ok: boolean;
	fiveHourUtilization?: number; // 0.0 to 1.0 (e.g. 0.45 = 45% used)
	sevenDayUtilization?: number; // 0.0 to 1.0
	fiveHourResetSec?: number;
	lastUpdated: number;
}

let latestClaudeQuota: ClaudeQuotaSnapshot | undefined;

export function getLatestClaudeQuota(): ClaudeQuotaSnapshot | undefined {
	return latestClaudeQuota;
}

function mapStopReason(anthropicStop: string | null | undefined): StopReason {
	switch (anthropicStop) {
		case "end_turn":
		case "stop_sequence":
		case "completed":
			return "stop";
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

function parseClaudeError(errorText: string): string {
	try {
		const parsed: unknown = JSON.parse(errorText);
		if (
			isRecord(parsed) &&
			isRecord(parsed.error) &&
			typeof parsed.error.message === "string"
		) {
			return parsed.error.message;
		}
	} catch {
		// Preserve the raw provider text when the response is not JSON.
	}
	return errorText;
}

function isQuotaOrRateLimit(status: number, message: string): boolean {
	return (
		status === 429 ||
		status === 529 ||
		/rate[_\\s-]*limit|quota[_\\s-]*exceeded|overloaded|free[_\\s-]*tier/i.test(
			message,
		)
	);
}

function failoverReason(status: number, message: string): string {
	if (/rate[_\\s-]*limit/i.test(message) || status === 429)
		return "rate_limit_exceeded";
	if (/quota[_\\s-]*exceeded|free[_\\s-]*tier/i.test(message))
		return "quota_exceeded";
	return status === 529 || /overloaded/i.test(message)
		? "provider_overloaded"
		: "provider_unavailable";
}

export function applyUsage(
	output: AssistantMessage,
	usage: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		output_tokens_details?: { thinking_tokens?: number };
	},
) {
	const prompt = usage.input_tokens || 0;
	const cached = usage.cache_read_input_tokens || 0;
	const cacheWrite = usage.cache_creation_input_tokens || 0;
	const candidates = usage.output_tokens || 0;
	const thoughts = usage.output_tokens_details?.thinking_tokens || 0;

	output.usage.input = Math.max(0, prompt - cached);
	output.usage.output = candidates;
	output.usage.cacheRead = cached;
	output.usage.cacheWrite = cacheWrite;
	output.usage.reasoning = thoughts;
	output.usage.totalTokens = prompt + candidates;
}

export class ClaudeClient {
	private host: string;
	private tokenStore: TokenStore;
	private transport: ClaudeTransport;
	private toolCallCounter = 0;
	private persistentSessionId = crypto.randomUUID();
	private fallbackStreamFactory: NonNullable<
		ClaudeClientConfig["fallbackStreamFactory"]
	>;
	private quotaCooldownMs: number;

	constructor(config: ClaudeClientConfig = {}) {
		this.host = config.host || DEFAULT_HOST;
		this.tokenStore = new TokenStore(config.apiKey, config.oauthToken);
		this.transport = new ClaudeTransport(
			this.host,
			config.userAgent,
			this.tokenStore,
		);
		this.fallbackStreamFactory =
			config.fallbackStreamFactory ?? streamSolUltraFallback;
		this.quotaCooldownMs = config.quotaCooldownMs ?? 5 * 60_000;
		this.transport.warm();
	}

	public warmConnection(): void {
		this.transport.warm();
	}

	public getTokenStore(): TokenStore {
		return this.tokenStore;
	}

	public async getStatus(defaultModel: string): Promise<ClaudeClientStatus> {
		const connected = this.tokenStore.hasSession();
		const authMode = this.tokenStore.getAuthMode();

		if (!connected) {
			return {
				connected: false,
				authMode: "none",
				endpoint: this.host,
				defaultModel,
			};
		}

		return {
			connected: true,
			authMode,
			tokenRemainingMinutes:
				authMode === "oauth"
					? this.tokenStore.getRemainingMinutes()
					: undefined,
			endpoint: this.host,
			defaultModel,
		};
	}

	public stream(
		model: Model,
		spec: ClaudeModelSpec,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		void (async () => {
			let current:
				| { type: "text"; index: number }
				| { type: "thinking"; index: number }
				| {
						type: "toolCall";
						index: number;
						id: string;
						name: string;
						rawArgs: string;
				  }
				| null = null;

			const closeCurrent = () => {
				if (!current) return;
				const block = output.content[current.index];
				if (current.type === "text" && block?.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: current.index,
						content: block.text,
						partial: output,
					});
				} else if (current.type === "thinking" && block?.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: current.index,
						content: block.thinking,
						partial: output,
					});
				} else if (current.type === "toolCall" && block?.type === "toolCall") {
					try {
						block.arguments = current.rawArgs.trim()
							? JSON.parse(current.rawArgs)
							: {};
					} catch {
						block.arguments = { raw: current.rawArgs };
					}
					stream.push({
						type: "toolcall_end",
						contentIndex: current.index,
						toolCall: block,
						partial: output,
					});
				}
				current = null;
			};

			try {
				stream.push({ type: "start", partial: output });

				if (!this.tokenStore.hasSession()) {
					throw new Error(
						"Claude authentication not found. Run `claude auth login` or set ANTHROPIC_API_KEY, then /reload.",
					);
				}

				const auth = await this.tokenStore.getAuth();
				const sessionId = options?.sessionId || this.persistentSessionId;
				const metadata =
					auth.mode === "oauth"
						? this.tokenStore.getMetadata(sessionId, auth)
						: undefined;
				const envelope = ClaudeConversationBuilder.buildEnvelope(
					model,
					spec,
					context,
					options,
					auth.mode,
					metadata,
				);

				const endpointPath =
					auth.mode === "oauth" ? "/v1/messages?beta=true" : "/v1/messages";

				const response = await this.transport.postWithRetry(
					endpointPath,
					auth,
					envelope,
					options?.signal,
					0,
					sessionId,
				);

				// Capture live rate limit headers into reactive QuotaStore
				ProviderQuotaStore.get().updateFromAnthropicHeaders(response.headers);

				if (!response.ok) {
					const parsedMessage = parseClaudeError(await response.text());
					if (isQuotaOrRateLimit(response.status, parsedMessage)) {
						const cooldownMs =
							parseRetryAfterMs(response.headers.get("retry-after")) ??
							this.quotaCooldownMs;
						const reason = failoverReason(response.status, parsedMessage);
						this.tokenStore.markRateLimited(auth, cooldownMs);
						ProviderQuotaStore.get().recordFailover({
							sourceProvider: "claude",
							targetProvider: "openai-codex",
							targetModel: "gpt-5.6-sol",
							reason,
							status: response.status,
							cooldownMs,
						});

						closeCurrent();
						output.model = "gpt-5.6-sol";
						output.provider = "openai-codex";
						output.api = "openai-codex-responses";
						const fallbackStream = this.fallbackStreamFactory(context, options);
						for await (const event of fallbackStream) {
							// The active turn already emitted its start event; forwarding a second one corrupts consumers.
							if (event.type !== "start") {
								if (event.partial) {
									event.partial.model = "gpt-5.6-sol";
									event.partial.provider = "openai-codex";
								}
								stream.push(event);
							}
						}
						stream.end();
						return;
					}
					throw new Error(
						`Claude API error (${response.status}): ${parsedMessage}`,
					);
				}

				for await (const event of this.transport.readSse(
					response,
					options?.signal,
				)) {
					const eventType = event.type;

					if (eventType === "message_start") {
						if (event.message?.id) output.responseId = event.message.id;
						if (event.message?.usage) {
							applyUsage(output, event.message.usage);
						}
					} else if (eventType === "content_block_start") {
						closeCurrent();
						const block = event.content_block;
						const idx = output.content.length;

						if (block?.type === "text") {
							output.content.push({ type: "text", text: block.text || "" });
							current = { type: "text", index: idx };
							stream.push({
								type: "text_start",
								contentIndex: idx,
								partial: output,
							});
							if (block.text) {
								stream.push({
									type: "text_delta",
									contentIndex: idx,
									delta: block.text,
									partial: output,
								});
							}
						} else if (block?.type === "thinking") {
							output.content.push({
								type: "thinking",
								thinking: block.thinking || "",
							});
							current = { type: "thinking", index: idx };
							stream.push({
								type: "thinking_start",
								contentIndex: idx,
								partial: output,
							});
							if (block.thinking) {
								stream.push({
									type: "thinking_delta",
									contentIndex: idx,
									delta: block.thinking,
									partial: output,
								});
							}
						} else if (block?.type === "tool_use") {
							const toolCall: ToolCall = {
								type: "toolCall",
								id: block.id || `tool_${Date.now()}_${++this.toolCallCounter}`,
								name: block.name || "",
								arguments: {},
							};
							output.content.push(toolCall);
							current = {
								type: "toolCall",
								index: idx,
								id: toolCall.id,
								name: toolCall.name,
								rawArgs: "",
							};
							stream.push({
								type: "toolcall_start",
								contentIndex: idx,
								partial: output,
							});
						}
					} else if (eventType === "content_block_delta") {
						const delta = event.delta;
						if (delta?.type === "text_delta" && delta.text) {
							if (current?.type !== "text") {
								closeCurrent();
								const idx = output.content.length;
								output.content.push({ type: "text", text: "" });
								current = { type: "text", index: idx };
								stream.push({
									type: "text_start",
									contentIndex: idx,
									partial: output,
								});
							}
							const block = output.content[current.index];
							if (block && block.type === "text") {
								block.text += delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: current.index,
									delta: delta.text,
									partial: output,
								});
							}
						} else if (delta?.type === "thinking_delta" && delta.thinking) {
							if (current?.type !== "thinking") {
								closeCurrent();
								const idx = output.content.length;
								output.content.push({ type: "thinking", thinking: "" });
								current = { type: "thinking", index: idx };
								stream.push({
									type: "thinking_start",
									contentIndex: idx,
									partial: output,
								});
							}
							const block = output.content[current.index];
							if (block && block.type === "thinking") {
								block.thinking += delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: current.index,
									delta: delta.thinking,
									partial: output,
								});
							}
						} else if (delta?.type === "signature_delta" && delta.signature) {
							if (current && current.type === "thinking") {
								const block = output.content[current.index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = delta.signature;
								}
							}
						} else if (
							delta?.type === "input_json_delta" &&
							delta.partial_json
						) {
							if (current && current.type === "toolCall") {
								current.rawArgs += delta.partial_json;
								stream.push({
									type: "toolcall_delta",
									contentIndex: current.index,
									delta: delta.partial_json,
									partial: output,
								});
							}
						}
					} else if (eventType === "content_block_stop") {
						closeCurrent();
					} else if (eventType === "message_delta") {
						if (event.delta?.stop_reason) {
							output.stopReason = mapStopReason(event.delta.stop_reason);
						}
						if (event.usage) {
							applyUsage(output, event.usage);
						}
					} else if (eventType === "message_stop") {
						closeCurrent();
						break;
					}
				}

				closeCurrent();
				if (output.stopReason === "pending") {
					output.stopReason = output.content.some((b) => b.type === "toolCall")
						? "toolUse"
						: "stop";
				}

				stream.push({
					type: "done",
					reason: output.stopReason as "stop" | "length" | "toolUse",
					message: output,
				});
				stream.end();
			} catch (error) {
				closeCurrent();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage =
					error instanceof Error ? error.message : String(error);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output,
				});
				stream.end();
			}
		})();

		return stream;
	}
}
