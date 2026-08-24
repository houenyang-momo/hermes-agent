import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CloudCodeModelSpec } from "./types.js";
import {
	extractTextContent,
	normalizeToolCallId,
	sanitizeJsonSchema,
	sanitizeSurrogates,
} from "../common/index.js";

const DEFAULT_SAFETY_SETTINGS = [
	{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
];

export { sanitizeSurrogates, normalizeToolCallId, sanitizeJsonSchema as sanitizeSchema };

export class GeminiConversationBuilder {
	public static buildEnvelope(
		model: Model,
		spec: CloudCodeModelSpec,
		context: Context,
		options: SimpleStreamOptions | undefined,
		project: string,
	): Record<string, unknown> {
		const contents = this.convertMessages(model, context);
		const tools = context.tools?.length ? this.convertTools(context.tools) : undefined;
		const thinking = this.resolveThinkingConfig(spec, options);

		const generationConfig: Record<string, unknown> = {
			maxOutputTokens: options?.maxTokens ?? spec.maxTokens,
			...(thinking ? { thinkingConfig: thinking } : {}),
		};
		if (options?.temperature !== undefined) {
			generationConfig.temperature = options.temperature;
		}

		const request: Record<string, unknown> = {
			contents,
			generationConfig,
			safetySettings: DEFAULT_SAFETY_SETTINGS,
		};

		if (context.systemPrompt) {
			request.systemInstruction = { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] };
		}
		if (tools) {
			request.tools = tools;
			if (options?.toolChoice === "none") {
				request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
			} else if (options?.toolChoice === "any") {
				request.toolConfig = { functionCallingConfig: { mode: "ANY" } };
			} else if (options?.toolChoice === "auto") {
				request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
			}
		}

		return {
			model: spec.backend,
			project,
			user_prompt_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			request,
		};
	}

	public static resolveThinkingConfig(spec: CloudCodeModelSpec, options?: SimpleStreamOptions) {
		const level = options?.reasoning;
		const isFlash = spec.id.includes("flash") || spec.backend.includes("flash");
		if (level === "off") {
			return isFlash
				? { thinkingBudget: 0, includeThoughts: false }
				: undefined;
		}
		if (level === "minimal") {
			return { thinkingLevel: "low", includeThoughts: false };
		}
		if (level === "low") {
			return { thinkingLevel: "low", includeThoughts: true };
		}
		if (level === "medium") {
			return { thinkingLevel: "medium", includeThoughts: true };
		}
		if (level === "high" || level === "xhigh" || level === "max") {
			return { thinkingLevel: "high", includeThoughts: true };
		}
		return { thinkingLevel: spec.effort, includeThoughts: true };
	}

	public static convertMessages(model: Model, context: Context): Array<Record<string, unknown>> {
		const contents: Array<Record<string, unknown>> = [];

		for (const msg of context.messages) {
			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
					continue;
				}
				const parts: Array<Record<string, unknown>> = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						parts.push({ text: sanitizeSurrogates(item.text) });
					} else if (item.type === "image" && model.input.includes("image")) {
						parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
					}
				}
				if (parts.length) contents.push({ role: "user", parts });
			} else if (msg.role === "assistant") {
				const parts: Array<Record<string, unknown>> = [];
				const sameModel = msg.provider === model.provider && msg.model === model.id;

				for (const block of msg.content) {
					if (block.type === "text") {
						if (!block.text && !block.textSignature) continue;
						parts.push({
							text: sanitizeSurrogates(block.text || ""),
							...(sameModel && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
						});
					} else if (block.type === "thinking") {
						if (sameModel) {
							if (!block.thinking && !block.thinkingSignature) continue;
							parts.push({
								thought: true,
								text: sanitizeSurrogates(block.thinking || ""),
								...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
							});
						} else if (block.thinking) {
							parts.push({ text: sanitizeSurrogates(block.thinking) });
						}
					} else if (block.type === "toolCall") {
						const toolCallId = normalizeToolCallId(block.id);
						parts.push({
							functionCall: {
								name: block.name,
								args: block.arguments ?? {},
								...(toolCallId ? { id: toolCallId } : {}),
							},
							...(sameModel && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
						});
					}
				}
				if (parts.length) contents.push({ role: "model", parts });
			} else if (msg.role === "toolResult") {
				const text = sanitizeSurrogates(extractTextContent(msg.content));
				const imageContent = (Array.isArray(msg.content) && model.input.includes("image"))
					? msg.content.filter((item): item is { type: "image"; mimeType: string; data: string } =>
						Boolean(item && typeof item === "object" && item.type === "image" && item.mimeType && item.data),
					)
					: [];
				const hasImages = imageContent.length > 0;
				const responseValue = text.length > 0 ? text : (hasImages ? "(see attached image)" : "");
				const toolCallId = normalizeToolCallId(msg.toolCallId);
				const imageParts = imageContent.map((img) => ({
					inlineData: { mimeType: img.mimeType, data: img.data },
				}));

				const functionResponsePart: Record<string, unknown> = {
					functionResponse: {
						name: msg.toolName,
						response: msg.isError ? { error: responseValue } : { output: responseValue },
						...(hasImages ? { parts: imageParts } : {}),
						...(toolCallId ? { id: toolCallId } : {}),
					},
				};

				const last = contents[contents.length - 1];
				const lastParts = last?.parts as Array<Record<string, unknown>> | undefined;
				if (last?.role === "user" && lastParts?.some((p) => p.functionResponse)) {
					lastParts.push(functionResponsePart);
				} else {
					contents.push({ role: "user", parts: [functionResponsePart] });
				}
			}
		}

		return contents;
	}

	public static sanitizeSchema(schema: unknown): unknown {
		if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
		const skip = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
			if (skip.has(key)) continue;
			out[key] = this.sanitizeSchema(value);
		}
		return out;
	}

	public static convertTools(tools: NonNullable<Context["tools"]>) {
		return [{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parametersJsonSchema: sanitizeJsonSchema(tool.parameters),
			})),
		}];
	}

	private static textOfParts(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text || "") : ""))
			.filter(Boolean)
			.join("\n");
	}
}
