/**
 * Stream client for MiniMax M3.
 */

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
} from "@earendil-works/pi-ai";
import { StreamTransport } from "../common/stream-transport.js";
import { MiniMaxConversationBuilder } from "./conversation-builder.js";
import { MiniMaxTokenStore } from "./token-store.js";
import type { MiniMaxClientConfig, MiniMaxClientStatus, MiniMaxModelSpec } from "./types.js";

const DEFAULT_HOST = "https://api.minimaxi.chat/v1";

function mapStopReason(finishReason: string | null | undefined): StopReason {
	switch (finishReason) {
		case "stop":
		case "completed":
			return "stop";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		case "length":
			return "length";
		default:
			return "stop";
	}
}

export class MiniMaxClient {
	private host: string;
	private tokenStore: MiniMaxTokenStore;
	private transport: StreamTransport;

	constructor(config: MiniMaxClientConfig = {}) {
		this.host = (config.host || process.env.MINIMAX_API_HOST || DEFAULT_HOST).replace(/\/+$/, "");
		this.tokenStore = new MiniMaxTokenStore(config.apiKey);
		this.transport = new StreamTransport({
			host: this.host,
			inactivityTimeoutMs: 45_000,
			requestTimeoutMs: 120_000,
			maxRetries: 3,
		});
		this.transport.warmConnection();
	}

	public getTokenStore(): MiniMaxTokenStore {
		return this.tokenStore;
	}

	public async getStatus(defaultModel: string): Promise<MiniMaxClientStatus> {
		const connected = this.tokenStore.hasSession();
		return {
			connected,
			authMode: this.tokenStore.getAuthMode(),
			endpoint: this.host,
			defaultModel,
			error: connected ? undefined : "No MINIMAX_API_KEY set",
		};
	}

	public stream(
		model: Model,
		spec: MiniMaxModelSpec,
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
			let currentTextIndex = -1;
			let currentThinkingIndex = -1;
			const toolCallsMap = new Map<number, { index: number; id: string; name: string; rawArgs: string }>();

			const closeText = () => {
				if (currentTextIndex >= 0) {
					const block = output.content[currentTextIndex];
					if (block?.type === "text") {
						stream.push({ type: "text_end", contentIndex: currentTextIndex, content: block.text, partial: output });
					}
					currentTextIndex = -1;
				}
			};

			const closeThinking = () => {
				if (currentThinkingIndex >= 0) {
					const block = output.content[currentThinkingIndex];
					if (block?.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: currentThinkingIndex, content: block.thinking, partial: output });
					}
					currentThinkingIndex = -1;
				}
			};

			try {
				stream.push({ type: "start", partial: output });

				const apiKey = this.tokenStore.getApiKey();
				if (!apiKey) {
					throw new Error("MiniMax API key not configured. Set MINIMAX_API_KEY environment variable or in ~/.pi/agent/auth.json.");
				}

				const payload = MiniMaxConversationBuilder.buildPayload(model, spec, context, options);

				const headers: Record<string, string> = {
					"Authorization": `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				};

				const response = await this.transport.postWithRetry(
					`${this.host}/chat/completions`,
					headers,
					payload,
					{ signal: options?.signal },
				);

				if (!response.ok) {
					const errBody = await response.text().catch(() => "");
					throw new Error(`MiniMax API error (${response.status}): ${errBody || response.statusText}`);
				}

				for await (const chunk of this.transport.readSse(response, options?.signal)) {
					if (!chunk) continue;

					// Usage accounting
					if (chunk.usage) {
						const prompt = chunk.usage.prompt_tokens || 0;
						const completion = chunk.usage.completion_tokens || 0;
						output.usage.input = prompt;
						output.usage.output = completion;
						output.usage.totalTokens = prompt + completion;
					}

					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta;

					// Reasoning / Thinking delta
					if (delta?.reasoning_content || delta?.thought) {
						const thoughtText = delta.reasoning_content || delta.thought || "";
						if (thoughtText) {
							if (currentThinkingIndex < 0) {
								closeText();
								currentThinkingIndex = output.content.length;
								output.content.push({ type: "thinking", thinking: "" });
								stream.push({ type: "thinking_start", contentIndex: currentThinkingIndex, partial: output });
							}
							const block = output.content[currentThinkingIndex] as any;
							block.thinking += thoughtText;
							stream.push({
								type: "thinking_delta",
								contentIndex: currentThinkingIndex,
								delta: thoughtText,
								partial: output,
							});
						}
					}

					// Content delta
					if (delta?.content) {
						closeThinking();
						if (currentTextIndex < 0) {
							currentTextIndex = output.content.length;
							output.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: output });
						}
						const block = output.content[currentTextIndex] as any;
						block.text += delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: currentTextIndex,
							delta: delta.content,
							partial: output,
						});
					}

					// Tool call deltas
					if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
						closeText();
						closeThinking();

						for (const tc of delta.tool_calls) {
							const tcIdx = tc.index ?? 0;
							let tcRecord = toolCallsMap.get(tcIdx);

							if (!tcRecord) {
								const contentIndex = output.content.length;
								const id = tc.id || `call_${Math.random().toString(36).slice(2, 9)}`;
								const name = tc.function?.name || "";
								const toolCallObj: any = {
									type: "toolCall",
									id,
									name,
									arguments: {},
								};
								output.content.push(toolCallObj);
								tcRecord = { index: contentIndex, id, name, rawArgs: "" };
								toolCallsMap.set(tcIdx, tcRecord);
								stream.push({ type: "toolcall_start", contentIndex, partial: output });
							}

							if (tc.function?.name && !tcRecord.name) {
								tcRecord.name = tc.function.name;
								const block = output.content[tcRecord.index] as any;
								block.name = tc.function.name;
							}

							if (tc.function?.arguments) {
								tcRecord.rawArgs += tc.function.arguments;
								stream.push({
									type: "toolcall_delta",
									contentIndex: tcRecord.index,
									delta: tc.function.arguments,
									partial: output,
								});
							}
						}
					}

					// Terminal finish reason
					if (choice.finish_reason) {
						closeText();
						closeThinking();

						// Finalize all open tool calls
						for (const tcRecord of toolCallsMap.values()) {
							const block = output.content[tcRecord.index] as any;
							try {
								block.arguments = tcRecord.rawArgs.trim() ? JSON.parse(tcRecord.rawArgs) : {};
							} catch {
								block.arguments = { raw: tcRecord.rawArgs };
							}
							stream.push({
								type: "toolcall_end",
								contentIndex: tcRecord.index,
								toolCall: block,
								partial: output,
							});
						}
						toolCallsMap.clear();

						output.stopReason = mapStopReason(choice.finish_reason);
						break;
					}
				}

				closeText();
				closeThinking();

				if (output.stopReason === "pending") {
					output.stopReason = "stop";
				}

				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end();
			} catch (err: any) {
				closeText();
				closeThinking();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = err instanceof Error ? err.message : String(err);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	}
}
