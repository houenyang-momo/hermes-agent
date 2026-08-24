/**
 * Test Suite for CloudCode / Antigravity Gemini Extension.
 *
 * Verifies:
 * 1. TokenStore concurrency & invalidation
 * 2. Surrogate sanitization
 * 3. Tool call ID normalization in assistant & toolResult turns
 * 4. Multimodal function response format
 * 5. Generation options (temperature, maxTokens, toolChoice)
 * 6. Live OAuth status & streaming generation
 */

import { CloudCodeClient } from "./client.js";
import { GeminiConversationBuilder, sanitizeSurrogates } from "./conversation-builder.js";
import { formatCloudCodeHttpError, parseCloudCodeError } from "./errors.js";
import { formatQuotaSnapshot, parseAgyQuotaPayload } from "./quota.js";
import { TokenStore } from "./token-store.js";
import type { CloudCodeModelSpec } from "./types.js";
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
		const bad = "Hello \uD800 World \uDFFF!";
		const cleaned = sanitizeSurrogates(bad);
		assert(!cleaned.includes("\uD800"), "Unpaired high surrogate replaced");
		assert(!cleaned.includes("\uDFFF"), "Unpaired low surrogate replaced");
		assert(cleaned === "Hello \uFFFD World \uFFFD!", "Replaced with U+FFFD");
	}

	console.log("\n=== 2. Conversation Builder & Tool Call ID Tests ===");
	{
		const mockModel: Model = {
			id: "gemini-3.7-flash-high",
			name: "Gemini 3.7 Flash",
			provider: "antigravity",
			api: "google-generative-ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65536,
		};

		const mockSpec: CloudCodeModelSpec = {
			id: "gemini-3.7-flash-high",
			name: "Gemini 3.7 Flash",
			backend: "gemini-3.7-flash-tiered",
			effort: "high",
			maxTokens: 65536,
		};

		const mockContext: Context = {
			systemPrompt: "You are a test helper.",
			messages: [
				{ role: "user", content: "Run tool test" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Calling tool now" },
						{
							type: "toolCall",
							id: "call:read-file.123",
							name: "read_file",
							arguments: { path: "package.json" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call:read-file.123",
					toolName: "read_file",
					content: [{ type: "text", text: '{"name": "test"}' }],
					isError: false,
				},
			],
			tools: [
				{
					name: "read_file",
					description: "Reads a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		};

		const envelope = GeminiConversationBuilder.buildEnvelope(
			mockModel,
			mockSpec,
			mockContext,
			{ temperature: 0.2, maxTokens: 4096, toolChoice: "auto" },
			"test-project-123",
		);

		const req = envelope.request as Record<string, unknown>;
		const genConfig = req.generationConfig as Record<string, unknown>;
		const contents = req.contents as Array<Record<string, unknown>>;

		assert(genConfig.temperature === 0.2, "Temperature option mapped to generationConfig");
		assert(genConfig.maxOutputTokens === 4096, "maxTokens option mapped to generationConfig");

		const assistantTurn = contents[1];
		const modelParts = assistantTurn.parts as Array<Record<string, unknown>>;
		const fnCall = modelParts[1].functionCall as { id?: string; name: string };
		assert(fnCall.id === "call_read-file_123", `functionCall includes normalized tool ID: ${fnCall.id}`);

		const userToolTurn = contents[2];
		const userParts = userToolTurn.parts as Array<Record<string, unknown>>;
		const fnResp = userParts[0].functionResponse as { id?: string; name: string; response: { output: string } };
		assert(fnResp.id === "call_read-file_123", `functionResponse includes matching normalized tool ID: ${fnResp.id}`);
		assert(fnResp.response.output === '{"name": "test"}', "functionResponse contains sanitized text output");

		const toolConfig = req.toolConfig as { functionCallingConfig: { mode: string } } | undefined;
		assert(toolConfig?.functionCallingConfig?.mode === "AUTO", "toolChoice 'auto' mapped to AUTO functionCallingConfig");
	}

	console.log("\n=== 3. TokenStore Mutex & Invalidation Tests ===");
	{
		const store = new TokenStore();
		assert(store.hasSession() === true, "TokenStore detects active session");

		// Test concurrency mutex
		const p1 = store.getAccessToken();
		const p2 = store.getAccessToken();
		const [t1, t2] = await Promise.all([p1, p2]);
		assert(typeof t1 === "string" && t1.length > 20, "getAccessToken returns valid token");
		assert(t1 === t2, "Concurrent getAccessToken calls return identical token");

		// Test invalidation
		store.invalidateToken();
		assert(process.env.CLOUDCODE_ACCESS_TOKEN === undefined, "invalidateToken removes env token");
	}

	console.log("\n=== 4. Quota + 429 Parser Tests ===");
	{
		const quotaBody = JSON.stringify({
			error: {
				code: 429,
				message: "Individual quota reached.",
				status: "RESOURCE_EXHAUSTED",
				details: [{
					reason: "QUOTA_EXHAUSTED",
					metadata: {
						model: "gemini-3.7-flash-tiered",
						quotaResetDelay: "49m14s",
						quotaResetTimeStamp: "2026-08-17T22:11:02Z",
					},
				}],
			},
		});
		const quota = parseCloudCodeError(quotaBody);
		assert(quota.exhausted === true, "Quota 429 marked exhausted");
		assert(quota.retryable === false, "Quota 429 is not retried");
		const formatted = formatCloudCodeHttpError(429, quotaBody);
		assert(formatted.includes("quota exhausted"), "Human quota error mentions exhausted");
		assert(formatted.includes("gemini-3.7-flash-tiered"), "Human quota error names the model");

		const snapshot = parseAgyQuotaPayload(JSON.stringify({
			status: "SUCCESS",
			command: {
				name: "usage",
				data: {
					description: "Shared weekly and 5-hour limits.",
					groups: [{
						name: "Gemini Models",
						buckets: [{
							id: "gemini-5h",
							name: "Five Hour Limit Remaining",
							remaining_fraction: 0,
							reset_time: "2026-08-17T22:11:02Z",
						}],
					}],
				},
			},
		}));
		assert(snapshot.ok === true, "agy quota payload parsed");
		assert(snapshot.groups[0].buckets[0].remainingFraction === 0, "5-hour remaining fraction preserved");
		assert(formatQuotaSnapshot(snapshot).includes("EMPTY"), "Empty bucket labeled EMPTY");
	}

	console.log("\n=== 5. Live CloudCode Client Status & Stream Test ===");
	{
		const client = new CloudCodeClient();
		const status = await client.getStatus("gemini-3.7-flash-high");
		assert(status.connected === true, `Cloud Code connected to project: ${status.project}`);
		assert(typeof status.tokenRemainingMinutes === "number", `OAuth token remaining: ${status.tokenRemainingMinutes}m`);

		// Live generation stream test
		console.log("  Streaming test prompt to Gemini 3.7 Flash...");
		const mockModel: Model = {
			id: "gemini-3.7-flash-high",
			name: "Gemini 3.7 Flash",
			provider: "antigravity",
			api: "google-generative-ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65536,
		};

		const mockSpec: CloudCodeModelSpec = {
			id: "gemini-3.7-flash-high",
			name: "Gemini 3.7 Flash",
			backend: "gemini-3.7-flash-tiered",
			effort: "high",
			maxTokens: 65536,
		};

		const stream = client.stream(
			mockModel,
			mockSpec,
			{
				messages: [{ role: "user", content: "Reply with exactly one word: 'HARDENED'." }],
			},
			{ reasoning: "low" },
		);

		let collectedText = "";
		let streamError = "";
		for await (const event of stream) {
			if (event.type === "text_delta") {
				collectedText += event.delta;
			}
			if (event.type === "error") {
				streamError = event.error?.errorMessage || "stream error";
			}
		}

		if (/quota exhausted/i.test(streamError)) {
			console.log(`  ⚠ Skipped live 3.7 stream: ${streamError}`);
		} else {
			assert(collectedText.trim().includes("HARDENED"), `Received model output: ${collectedText.trim()}`);
		}
	}

	console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===\n`);
	if (failed > 0) {
		process.exit(1);
	}
}

runTests().catch((err) => {
	console.error("Test execution failed:", err);
	process.exit(1);
});
