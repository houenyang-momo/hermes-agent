import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import { CloudCodeTransport } from "./transport.js";
import { formatCloudCodeHttpError } from "./errors.js";
import type { CloudCodeClientConfig, CloudCodeModelSpec, CloudCodeStatus } from "./types.js";

const DEFAULT_HOST = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Antigravity/1.1.13";
const DEFAULT_CLIENT_METADATA = JSON.stringify({
	ideType: "ANTIGRAVITY",
	platform: "DARWIN_ARM64",
	pluginType: "GEMINI",
});

export class CloudCodeClient {
	private host: string;
	private tokenStore: TokenStore;
	private transport: CloudCodeTransport;
	private toolCallCounter = 0;

	constructor(config: CloudCodeClientConfig = {}) {
		this.host = config.host || DEFAULT_HOST;
		this.tokenStore = new TokenStore(config.clientId, config.clientSecret);
		const userAgent = config.userAgent || DEFAULT_USER_AGENT;
		const clientMetadata = config.clientMetadata ? JSON.stringify(config.clientMetadata) : DEFAULT_CLIENT_METADATA;
		this.transport = new CloudCodeTransport(this.host, userAgent, clientMetadata, this.tokenStore);
	}

	public getTokenStore(): TokenStore {
		return this.tokenStore;
	}

	public async getStatus(defaultModel: string): Promise<CloudCodeStatus> {
		const connected = this.tokenStore.hasSession();
		if (!connected) {
			return { connected: false, endpoint: this.host, defaultModel };
		}
		try {
			const token = await this.tokenStore.getAccessToken();
			const project = await this.transport.loadProjectId(token);
			return {
				connected: true,
				project,
				tokenRemainingMinutes: this.tokenStore.getRemainingMinutes(),
				endpoint: this.host,
				defaultModel,
			};
		} catch (error) {
			return {
				connected: false,
				endpoint: this.host,
				defaultModel,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	public stream(
		model: Model,
		spec: CloudCodeModelSpec,
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
			let current: { type: "text" | "thinking"; index: number } | null = null;
			const closeCurrent = () => {
				if (!current) return;
				const block = output.content[current.index];
				if (current.type === "text" && block?.type === "text") {
					stream.push({ type: "text_end", contentIndex: current.index, content: block.text, partial: output });
				} else if (current.type === "thinking" && block?.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex: current.index, content: block.thinking, partial: output });
				}
				current = null;
			};

			try {
				stream.push({ type: "start", partial: output });

				if (!this.tokenStore.hasSession()) {
					throw new Error("Antigravity is not logged in. Run `agy` in a terminal to sign in with Google, then /reload.");
				}

				const accessToken = await this.tokenStore.getAccessToken();
				const project = await this.transport.loadProjectId(accessToken);
				const envelope = GeminiConversationBuilder.buildEnvelope(model, spec, context, options, project);

				const response = await this.transport.postWithRetry(
					"streamGenerateContent?alt=sse",
					accessToken,
					envelope,
					options?.signal,
				);

				if (!response.ok) {
					throw new Error(formatCloudCodeHttpError(response.status, await response.text()));
				}

				for await (const raw of this.transport.readSse(response, options?.signal)) {
					const rawErr = (raw as Record<string, unknown>)?.error as { code?: number; status?: string; message?: string } | undefined;
					if (rawErr) {
						throw new Error(`Google Cloud Code error (${rawErr.code || rawErr.status || "UNKNOWN"}): ${rawErr.message || JSON.stringify(rawErr)}`);
					}

					const obj = raw as {
						response?: {
							candidates?: Array<{
								content?: { parts?: Array<Record<string, unknown>> };
								finishReason?: string;
							}>;
							usageMetadata?: Record<string, unknown>;
						};
						traceId?: string;
					};
					const inner = obj.response;
					if (obj.traceId && !output.responseId) output.responseId = obj.traceId;

					const candidate = inner?.candidates?.[0];
					const parts = candidate?.content?.parts || [];

					for (const part of parts) {
						const thought = Boolean(part.thought);
						const text = typeof part.text === "string" ? part.text : undefined;

						if (text !== undefined) {
							if (!current || (thought && current.type !== "thinking") || (!thought && current.type !== "text")) {
								closeCurrent();
								if (thought) {
									output.content.push({ type: "thinking", thinking: "" });
									current = { type: "thinking", index: output.content.length - 1 };
									stream.push({ type: "thinking_start", contentIndex: current.index, partial: output });
								} else {
									output.content.push({ type: "text", text: "" });
									current = { type: "text", index: output.content.length - 1 };
									stream.push({ type: "text_start", contentIndex: current.index, partial: output });
								}
							}
							const block = output.content[current.index];
							if (current.type === "thinking" && block.type === "thinking") {
								block.thinking += text;
								if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
									block.thinkingSignature = part.thoughtSignature;
								}
								stream.push({ type: "thinking_delta", contentIndex: current.index, delta: text, partial: output });
							} else if (block.type === "text") {
								block.text += text;
								if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
									block.textSignature = part.thoughtSignature;
								}
								stream.push({ type: "text_delta", contentIndex: current.index, delta: text, partial: output });
							}
						}

						const fn = part.functionCall as { id?: string; name?: string; args?: Record<string, unknown> } | undefined;
						if (fn) {
							closeCurrent();
							const providedId = fn.id;
							const needsNewId = !providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const id = needsNewId ? `${fn.name || "tool"}_${Date.now()}_${++this.toolCallCounter}` : providedId;
							const toolCall: ToolCall = {
								type: "toolCall",
								id,
								name: fn.name || "",
								arguments: (fn.args ?? {}) as Record<string, unknown>,
								...(typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
									? { thoughtSignature: part.thoughtSignature }
									: {}),
							};
							output.content.push(toolCall);
							const idx = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
							stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(toolCall.arguments), partial: output });
							stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
						}
					}

					if (candidate?.finishReason) {
						output.rawStopReason = candidate.finishReason;
						output.stopReason = this.mapFinish(
							candidate.finishReason,
							output.content.some((b) => b.type === "toolCall"),
						);
						if (output.stopReason === "error" && !output.errorMessage) {
							output.errorMessage = `Content generation stopped by provider: ${candidate.finishReason}`;
						}
						if (inner?.usageMetadata) this.applyUsage(output, inner.usageMetadata);
						closeCurrent();
						break;
					}
					if (inner?.usageMetadata) this.applyUsage(output, inner.usageMetadata);
				}

				closeCurrent();
				if (output.stopReason === "pending") {
					output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
				}

				if (output.stopReason === "error" || output.stopReason === "aborted") {
					throw new Error(output.errorMessage || `Provider stopped with ${output.rawStopReason || "error"}`);
				}

				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end();
			} catch (error) {
				closeCurrent();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	}

	private applyUsage(output: AssistantMessage, usage: Record<string, unknown> | undefined) {
		if (!usage) return;
		const prompt = Number(usage.promptTokenCount) || 0;
		const cached = Number(usage.cachedContentTokenCount) || 0;
		const candidates = Number(usage.candidatesTokenCount) || 0;
		const thoughts = Number(usage.thoughtsTokenCount) || 0;
		output.usage.input = Math.max(0, prompt - cached);
		output.usage.output = candidates;
		output.usage.cacheRead = cached;
		output.usage.cacheWrite = 0;
		output.usage.reasoning = thoughts;
		output.usage.totalTokens = Number(usage.totalTokenCount) || (prompt + candidates);
	}

	private mapFinish(reason: string | undefined, hasTool: boolean): StopReason {
		if (hasTool) return "toolUse";
		if (!reason) return "stop";
		const upper = reason.toUpperCase();
		if (upper.includes("MAX") || upper.includes("LENGTH")) return "length";
		if (upper === "STOP" || upper === "END_OF_TURN") return "stop";
		// SAFETY, BLOCKLIST, PROHIBITED_CONTENT, SPII, RECITATION, MALFORMED_FUNCTION_CALL
		return "error";
	}
}
