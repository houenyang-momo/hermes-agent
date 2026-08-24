/**
 * Test Suite for Claude Provider Extension.
 *
 * Verifies:
 * 1. Surrogate sanitization
 * 2. Protocol conversion & tool call ID normalization
 * 3. Strict turn collation (alternating user/assistant turns)
 * 4. Adaptive thinking budget & temperature constraints
 * 5. Prompt caching breakpoints on system & tools
 * 6. TokenStore mutex & concurrency safety
 * 7. Live client status
 */

import { ClaudeClient } from "./client.js";
import {
	ClaudeConversationBuilder,
	normalizeToolCallId,
	sanitizeSchema,
	sanitizeSurrogates,
} from "./conversation-builder.js";
import { TokenStore } from "./token-store.js";
import type { ClaudeModelSpec } from "./types.js";
import type { Context, Model } from "@earendil-works/pi-ai";

let failed = 0;
let passed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ ${msg}`);
		failed++;
	}
}

async function runTests() {
	console.log("\n=== 1. Surrogate Sanitization Tests ===");
	{
		const bad = "Test \uD800 String \uDFFF with unpaired surrogates";
		const cleaned = sanitizeSurrogates(bad);
		assert(!cleaned.includes("\uD800"), "Unpaired high surrogate replaced");
		assert(!cleaned.includes("\uDFFF"), "Unpaired low surrogate replaced");
		assert(cleaned === "Test \uFFFD String \uFFFD with unpaired surrogates", "Replaced with U+FFFD");
	}

	console.log("\n=== 2. Tool Call ID Normalization & Schema Sanitization ===");
	{
		const rawId = "call:special.tool-123/abc@xyz";
		const normalized = normalizeToolCallId(rawId);
		assert(normalized === "call_special_tool-123_abc_xyz", `Tool ID normalized correctly: ${normalized}`);

		const rawSchema = {
			$schema: "http://json-schema.org/draft-07/schema#",
			$id: "my-schema",
			type: "object",
			properties: {
				name: { type: "string" },
			},
			definitions: { extra: { type: "number" } },
		};
		const cleanedSchema = sanitizeSchema(rawSchema) as Record<string, any>;
		assert(!cleanedSchema.$schema, "$schema keyword stripped");
		assert(!cleanedSchema.$id, "$id keyword stripped");
		assert(!cleanedSchema.definitions, "definitions keyword stripped");
		assert(cleanedSchema.properties?.name?.type === "string", "properties preserved");
	}

	console.log("\n=== 3. Conversation Builder & Reasoning Tests ===");
	{
		const mockModel: Model = {
			id: "claude-opus-5",
			name: "(oAuth) Claude Opus 5",
			provider: "claude",
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128000,
		};

		const mockSpec: ClaudeModelSpec = {
			id: "claude-opus-5",
			name: "(oAuth) Claude Opus 5",
			backend: "claude-opus-5",
			effort: "high",
			thinkingBudgetTokens: 64000,
			maxTokens: 128000,
			contextWindow: 1000000,
			supportsAdaptiveThinking: true,
			supportsEffort: true,
		};

		const mockContext: Context = {
			systemPrompt: "You are an elite coding agent.",
			messages: [
				{ role: "user", content: "Optimize this algorithm." },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Analyzing time complexity..." },
						{ type: "text", text: "Let me inspect the files." },
						{
							type: "toolCall",
							id: "call:read-file.456",
							name: "read",
							arguments: { path: "src/algo.ts" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call:read-file.456",
					toolName: "read",
					content: [{ type: "text", text: "export function solve() {}" }],
					isError: false,
				},
			],
			tools: [
				{
					name: "read",
					description: "Reads a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		};

		const payload = ClaudeConversationBuilder.buildEnvelope(
			mockModel,
			mockSpec,
			mockContext,
			{ reasoning: "high" },
			"oauth",
		);

		assert(payload.model === "claude-opus-5", "Model backend is claude-opus-5");
		assert(payload.max_tokens === 128000, "Max output tokens is 128000");
		assert(payload.stream === true, "Stream is enabled");

		const thinking = payload.thinking as { type: string };
		assert(thinking.type === "adaptive", "Thinking is adaptive for Opus 5");
		assert(payload.temperature === 1, "Temperature is 1 when thinking is enabled");

		// System prompt caching
		const sys = payload.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
		const cachedSysBlock = sys.find((b) => b.cache_control?.type === "ephemeral");
		assert(Boolean(cachedSysBlock), "System prompt has ephemeral cache_control");

		// Tools caching
		const tools = payload.tools as Array<{ name: string; cache_control?: { type: string } }>;
		assert(tools[tools.length - 1].cache_control?.type === "ephemeral", "Last tool has ephemeral cache_control");

		// Message collation and tool call ID matching
		const messages = payload.messages as Array<{ role: string; content: Array<Record<string, any>> }>;
		assert(messages.length === 3, `Messages collated into alternating turns (count: ${messages.length})`);

		const assistantTurn = messages[1];
		assert(assistantTurn.role === "assistant", "Turn 1 is assistant");
		const toolUseBlock = assistantTurn.content.find((b) => b.type === "tool_use");
		assert(toolUseBlock?.id === "call_read-file_456", `tool_use has normalized ID: ${toolUseBlock?.id}`);

		const userTurn2 = messages[2];
		assert(userTurn2.role === "user", "Turn 2 is user (tool_result)");
		const toolResultBlock = userTurn2.content.find((b) => b.type === "tool_result");
		assert(toolResultBlock?.tool_use_id === "call_read-file_456", `tool_result matches tool_use_id: ${toolResultBlock?.tool_use_id}`);
	}

	console.log("\n=== 4. Opus 4.8 Spec Verification ===");
	{
		const opusModel: Model = {
			id: "claude-opus-4-8",
			name: "(oAuth) Claude Opus 4.8",
			provider: "claude",
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128000,
		};

		const opusSpec: ClaudeModelSpec = {
			id: "claude-opus-4-8",
			name: "(oAuth) Claude Opus 4.8",
			backend: "claude-opus-4-8",
			effort: "high",
			thinkingBudgetTokens: 64000,
			maxTokens: 128000,
			contextWindow: 1000000,
			supportsAdaptiveThinking: true,
			supportsEffort: true,
		};

		const payload = ClaudeConversationBuilder.buildEnvelope(
			opusModel,
			opusSpec,
			{ messages: [{ role: "user", content: "Solve hard reasoning problem." }] },
			{ reasoning: "high" },
			"oauth",
		);

		assert(payload.model === "claude-opus-4-8", "Opus 4.8 backend mapped");
		assert((payload.thinking as any)?.type === "adaptive", "Opus 4.8 adaptive thinking mapped");
		assert(payload.max_tokens === 128000, "Opus 4.8 maxTokens is 128000");
	}

	console.log("\n=== 5. TokenStore Mutex & Fallback Tests ===");
	{
		const store = new TokenStore();
		const hasSession = store.hasSession();
		console.log(`  ℹ Session detected: ${hasSession} (Auth mode: ${store.getAuthMode()})`);

		// Test explicit API key mode
		const apiKeyStore = new TokenStore("sk-ant-test-key-12345");
		assert(apiKeyStore.getAuthMode() === "api-key", "Explicit API key triggers api-key mode");
		const auth = await apiKeyStore.getAuth();
		assert(auth.token === "sk-ant-test-key-12345", "getAuth returns exact API key");
		assert(auth.mode === "api-key", "getAuth returns api-key mode");

		// Test concurrency mutex on API key store
		const [a1, a2] = await Promise.all([apiKeyStore.getAuth(), apiKeyStore.getAuth()]);
		assert(a1.token === a2.token, "Concurrent getAuth calls return identical auth token");
	}

	console.log("\n=== 6. Live Claude Client Status Test ===");
	{
		const client = new ClaudeClient();
		const status = await client.getStatus("claude-opus-5");
		console.log(`  ℹ Claude Client Status: connected=${status.connected}, authMode=${status.authMode}, endpoint=${status.endpoint}`);
		assert(typeof status.connected === "boolean", "getStatus returns boolean connected");
	}

	console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===\n`);
	if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
	console.error("Test suite threw uncaught error:", err);
	process.exit(1);
});
