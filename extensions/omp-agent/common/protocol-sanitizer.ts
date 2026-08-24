/**
 * Shared Protocol & Schema Sanitizer for Pi Agent Provider Extensions.
 *
 * Provides single-pass normalization for:
 * - Unpaired UTF-16 surrogate code point sanitization (prevents HTTP 400 Bad Request)
 * - Tool Call ID normalization ([a-zA-Z0-9_-]{1,64})
 * - Recursive JSON Schema keyword stripping ($schema, definitions, $id, etc.)
 * - Polymorphic text content flattening across string, array, and object part formats
 */

const TOOL_ID_INVALID_CHARS = /[^a-zA-Z0-9_-]/g;
const UNSUPPORTED_SCHEMA_KEYS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);

/**
 * Sanitizes unpaired UTF-16 surrogate code points to U+FFFD.
 * Prevents HTTP 400 Bad Request crashes when terminal output contains partial binary slices.
 */
export function sanitizeSurrogates(text: unknown): string {
	const value = typeof text === "string"
		? text
		: text === null || text === undefined
			? ""
			: String(text);
	return value.toWellFormed();
}

/**
 * Normalizes tool call IDs to alphanumeric + underscore/dash, max 64 characters.
 */
export function normalizeToolCallId(id: string | undefined): string | undefined {
	if (!id) return undefined;
	return id.replace(TOOL_ID_INVALID_CHARS, "_").slice(0, 64);
}

/**
 * Recursively removes unsupported JSON Schema keywords ($schema, $id, definitions, etc.)
 * that cause validation errors in Anthropic and Gemini schema validators.
 */
export function sanitizeJsonSchema(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
		if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
		out[key] = sanitizeJsonSchema(value);
	}
	return out;
}

/**
 * Robust text extractor for polymorphic tool result / message part contents.
 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
					return (part as any).text;
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
