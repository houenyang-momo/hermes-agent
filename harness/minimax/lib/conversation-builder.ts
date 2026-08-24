/**
 * Protocol & Conversation Builder for MiniMax M3.
 */

import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	extractTextContent,
	normalizeToolCallId,
	sanitizeJsonSchema,
	sanitizeSurrogates,
} from "../common/protocol-sanitizer.js";
import type { MiniMaxModelSpec } from "./types.js";

export class MiniMaxConversationBuilder {
	public static buildPayload(
		model: Model,
		spec: MiniMaxModelSpec,
		context: Context,
		options?: SimpleStreamOptions,
	): Record<string, unknown> {
		const messages: Record<string, unknown>[] = [];

		// System prompt
		if (context.systemPrompt) {
			messages.push({
				role: "system",
				content: sanitizeSurrogates(context.systemPrompt),
			});
		}

		// Message sequence
		for (const msg of context.messages) {
			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					messages.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				} else if (Array.isArray(msg.content)) {
					const parts: any[] = [];
					for (const part of msg.content) {
						if (part.type === "text") {
							parts.push({ type: "text", text: sanitizeSurrogates(part.text) });
						} else if (part.type === "image") {
							const mime = (part as any).mimeType || "image/png";
							const data = (part as any).data || (part as any).base64;
							if (data) {
								parts.push({
									type: "image_url",
									image_url: { url: `data:${mime};base64,${data}` },
								});
							}
						}
					}
					messages.push({ role: "user", content: parts });
				}
			} else if (msg.role === "assistant") {
				let textContent = "";
				const toolCalls: any[] = [];

				if (typeof msg.content === "string") {
					textContent = sanitizeSurrogates(msg.content);
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text") {
							textContent += sanitizeSurrogates(block.text);
						} else if (block.type === "toolCall") {
							toolCalls.push({
								id: normalizeToolCallId(block.id) || `call_${Math.random().toString(36).slice(2, 9)}`,
								type: "function",
								function: {
									name: block.name,
									arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {}),
								},
							});
						}
					}
				}

				const assistantMsg: Record<string, unknown> = {
					role: "assistant",
					content: textContent || null,
				};
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				messages.push(assistantMsg);
			} else if (msg.role === "toolResult") {
				const toolCallId = normalizeToolCallId((msg as any).toolCallId || (msg as any).id);
				const contentStr = extractTextContent(msg.content);
				messages.push({
					role: "tool",
					tool_call_id: toolCallId || "unknown_call",
					content: sanitizeSurrogates(contentStr),
				});
			}
		}

		const payload: Record<string, unknown> = {
			model: spec.backend || model.id,
			messages,
			stream: true,
			max_tokens: options?.maxTokens || spec.maxTokens,
		};

		if (options?.temperature !== undefined) {
			payload.temperature = options.temperature;
		}

		// Tools
		if (spec.supportsTools !== false && context.tools && context.tools.length > 0) {
			payload.tools = context.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description || "",
					parameters: sanitizeJsonSchema(t.parameters || { type: "object", properties: {} }),
				},
			}));
		}

		return payload;
	}
}
