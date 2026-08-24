import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { ClaudeModelSpec } from "./types.js";
import {
	extractTextContent,
	normalizeToolCallId,
	sanitizeJsonSchema,
	sanitizeSurrogates,
} from "../common/index.js";

const BILLING_HEADER_TEXT = "x-anthropic-billing-header: cc_version=2.1.234.f9c; cc_entrypoint=sdk-cli;";

export { sanitizeSurrogates, normalizeToolCallId, sanitizeJsonSchema as sanitizeSchema };

export class ClaudeConversationBuilder {
	public static buildEnvelope(
		model: Model,
		spec: ClaudeModelSpec,
		context: Context,
		options?: SimpleStreamOptions,
		authMode: "oauth" | "api-key" = "oauth",
		metadata?: Record<string, unknown>,
	): Record<string, unknown> {
		const isOAuth = authMode === "oauth";
		const messages = this.convertMessages(model, context, isOAuth);
		const tools = context.tools?.length ? this.convertTools(context.tools, isOAuth) : undefined;
		const thinking = this.resolveThinkingConfig(spec, options);

		const maxOutputTokens = options?.maxTokens ?? spec.maxTokens ?? 64000;

		const payload: Record<string, unknown> = {
			model: spec.backend,
			messages,
			max_tokens: maxOutputTokens,
			stream: true,
		};

		// System prompt construction with Ephemeral Prompt Caching
		const systemBlocks: Array<Record<string, unknown>> = [];

		if (isOAuth) {
			systemBlocks.push({
				type: "text",
				text: BILLING_HEADER_TEXT,
			});
		}

		if (context.systemPrompt) {
			systemBlocks.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				cache_control: isOAuth ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
			});
		}

		if (systemBlocks.length > 0) {
			payload.system = systemBlocks;
		}

		// Metadata and OAuth-specific configuration
		if (isOAuth) {
			if (metadata) {
				payload.metadata = metadata;
			}
			if (thinking && (thinking.type === "enabled" || thinking.type === "adaptive")) {
				payload.context_management = {
					edits: [{ type: "clear_thinking_20251015", keep: "all" }],
				};
			}

			const effort = options?.reasoning || spec.effort || "high";
			if (effort !== "off" && spec.supportsEffort !== false) {
				const effortMap: Record<string, string> = {
					minimal: "low",
					low: "medium",
					medium: "high",
					high: spec.backend === "claude-opus-4-6" ? "high" : "xhigh",
					xhigh: "max",
					max: "max",
					ultracode: "max",
				};
				payload.output_config = {
					effort: effortMap[effort] || "high",
				};
			}
		}

		// Thinking configuration
		if (thinking) {
			payload.thinking = thinking;
			if (thinking.type === "enabled" || thinking.type === "adaptive") {
				payload.temperature = 1;
			} else if (options?.temperature !== undefined) {
				payload.temperature = options.temperature;
			}
		} else if (options?.temperature !== undefined) {
			payload.temperature = options.temperature;
		}

		// Tools configuration
		if (tools && tools.length > 0) {
			payload.tools = tools;
			if (options?.toolChoice === "none") {
				payload.tool_choice = { type: "none" };
			} else if (options?.toolChoice === "any") {
				payload.tool_choice = { type: "any" };
			} else if (options?.toolChoice === "auto") {
				payload.tool_choice = { type: "auto" };
			}
		}

		return payload;
	}

	public static resolveThinkingConfig(
		spec: ClaudeModelSpec,
		options?: SimpleStreamOptions,
	): { type: "enabled"; budget_tokens: number } | { type: "disabled" } | { type: "adaptive" } | undefined {
		const effort = options?.reasoning || spec.effort || "max";

		if (effort === "off") {
			return { type: "disabled" };
		}

		if (spec.supportsAdaptiveThinking && (effort === "auto" || effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultracode")) {
			return { type: "adaptive" };
		}

		let budget = 64000;

		switch (effort) {
			case "minimal":
				budget = 2048; // low
				break;
			case "low":
				budget = 8192; // medium
				break;
			case "medium":
				budget = 16384; // high
				break;
			case "high":
				budget = 32768; // xhigh
				break;
			case "xhigh":
				budget = 64000; // max
				break;
			case "max":
			case "ultracode":
			default:
				budget = spec.thinkingBudgetTokens || 64000; // ultracode
				break;
		}

		const maxTokens = options?.maxTokens ?? spec.maxTokens ?? 64000;
		if (budget >= maxTokens) {
			budget = Math.max(1024, maxTokens - 4096);
		}

		return {
			type: "enabled",
			budget_tokens: budget,
		};
	}

	public static convertTools(tools: Tool[], isOAuth = true): Array<Record<string, unknown>> {
		const converted: Array<Record<string, unknown>> = [];

		for (let i = 0; i < tools.length; i++) {
			const tool = tools[i];
			const isLast = i === tools.length - 1;

			const toolDef: Record<string, unknown> = {
				name: tool.name,
				description: tool.description || "",
				input_schema: sanitizeJsonSchema(tool.parameters || { type: "object", properties: {} }),
			};

			// Add ephemeral cache control to the last tool definition matching system TTL
			if (isLast) {
				toolDef.cache_control = isOAuth ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
			}

			converted.push(toolDef);
		}

		return converted;
	}

	public static convertMessages(model: Model, context: Context, isOAuth = true): Array<Record<string, unknown>> {
		const rawTurns: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];

		for (const msg of context.messages) {
			if (msg.role === "user") {
				const parts: Array<Record<string, unknown>> = [];
				if (typeof msg.content === "string") {
					if (msg.content.trim()) {
						parts.push({ type: "text", text: sanitizeSurrogates(msg.content) });
					}
				} else if (Array.isArray(msg.content)) {
					for (const item of msg.content) {
						if (item.type === "text" && item.text) {
							parts.push({ type: "text", text: sanitizeSurrogates(item.text) });
						} else if (item.type === "image" && item.data && model.input.includes("image")) {
							parts.push({
								type: "image",
								source: {
									type: "base64",
									media_type: item.mimeType || "image/png",
									data: item.data,
								},
							});
						}
					}
				}
				if (parts.length > 0) {
					rawTurns.push({ role: "user", content: parts });
				}
			} else if (msg.role === "assistant") {
				const parts: Array<Record<string, unknown>> = [];
				for (const block of msg.content) {
					if (block.type === "text") {
						if (block.text) {
							parts.push({ type: "text", text: sanitizeSurrogates(block.text) });
						}
					} else if (block.type === "thinking") {
						if (block.thinking) {
							parts.push({
								type: "thinking",
								thinking: sanitizeSurrogates(block.thinking),
								...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
							});
						}
					} else if (block.type === "toolCall") {
						const toolCallId = normalizeToolCallId(block.id);
						parts.push({
							type: "tool_use",
							id: toolCallId,
							name: block.name,
							input: block.arguments ?? {},
						});
					}
				}
				if (parts.length > 0) {
					rawTurns.push({ role: "assistant", content: parts });
				}
			} else if (msg.role === "toolResult") {
				const toolCallId = normalizeToolCallId(msg.toolCallId);
				const text = sanitizeSurrogates(extractTextContent(msg.content));

				const toolResultContent: Array<Record<string, unknown>> = [];
				if (text) {
					toolResultContent.push({ type: "text", text });
				}

				// Check for embedded images in tool results
				if (Array.isArray(msg.content) && model.input.includes("image")) {
					for (const part of msg.content) {
						if (part && typeof part === "object" && part.type === "image" && part.data) {
							toolResultContent.push({
								type: "image",
								source: {
									type: "base64",
									media_type: part.mimeType || "image/png",
									data: part.data,
								},
							});
						}
					}
				}

				const toolResultBlock: Record<string, unknown> = {
					type: "tool_result",
					tool_use_id: toolCallId,
					content: toolResultContent.length > 0 ? toolResultContent : [{ type: "text", text: "(empty)" }],
					is_error: Boolean(msg.isError),
				};

				rawTurns.push({ role: "user", content: [toolResultBlock] });
			}
		}

		// Anthropic strict turn alternation: Merge consecutive turns with the same role
		const collated: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
		for (const turn of rawTurns) {
			const prev = collated[collated.length - 1];
			if (prev && prev.role === turn.role) {
				prev.content.push(...turn.content);
			} else {
				collated.push({ role: turn.role, content: [...turn.content] });
			}
		}

		// Ensure at least one user turn exists
		if (collated.length === 0) {
			collated.push({ role: "user", content: [{ type: "text", text: "Hello" }] });
		}

		// Apply prompt caching breakpoint to the second-to-last user turn if multi-turn
		if (collated.length >= 3) {
			const targetTurn = collated[collated.length - 2];
			if (targetTurn.role === "user" && targetTurn.content.length > 0) {
				const lastBlock = targetTurn.content[targetTurn.content.length - 1];
				lastBlock.cache_control = isOAuth ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
			}
		}

		return collated;
	}

	private static textOfParts(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((p) => {
					if (typeof p === "string") return p;
					if (p && typeof p === "object" && "text" in p && typeof (p as any).text === "string") {
						return (p as any).text;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}
		if (content && typeof content === "object") {
			return JSON.stringify(content);
		}
		return "";
	}
}
