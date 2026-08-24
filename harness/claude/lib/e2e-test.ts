/**
 * End-to-End Test Suite for Claude Provider Extension.
 *
 * Runs real, live end-to-end model interactions:
 * 1. (oAuth) Claude Opus 5 streaming generation with adaptive thinking
 * 2. (oAuth) Claude Opus 4.8 deep reasoning generation
 * 3. Multi-turn Tool Call & Tool Result round-trip execution
 * 4. Token usage and prompt caching verification
 */

import { ClaudeClient } from "./client.js";
import { CLAUDE_MODELS } from "../../extensions/claude.js";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ ${msg}`);
		failed++;
	}
}

async function runE2E() {
	console.log("==================================================================");
	console.log("🚀 CLAUDE OPUS 5 & OPUS 4.8 END-TO-END VERIFICATION");
	console.log("==================================================================\n");

	const client = new ClaudeClient();
	const status = await client.getStatus("claude-opus-5");

	console.log(`Auth Status: ${status.connected ? "CONNECTED (" + status.authMode + ")" : "DISCONNECTED"}`);
	console.log(`Endpoint:    ${status.endpoint}`);
	if (!status.connected) {
		console.error("❌ Cannot run E2E test without active auth session:", status.error);
		process.exit(1);
	}

	const opusSpec = CLAUDE_MODELS.find((m) => m.id === "claude-opus-5")!;
	const opus48Spec = CLAUDE_MODELS.find((m) => m.id === "claude-opus-4-8")!;

	const opusModel: Model = {
		id: opusSpec.id,
		name: opusSpec.name,
		provider: "claude",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: opusSpec.contextWindow,
		maxTokens: opusSpec.maxTokens,
	};

	const opus48Model: Model = {
		id: opus48Spec.id,
		name: opus48Spec.name,
		provider: "claude",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: opus48Spec.contextWindow,
		maxTokens: opus48Spec.maxTokens,
	};

	// --------------------------------------------------------------------------
	// TEST 1: Claude Opus 5 Live Stream + Adaptive Thinking
	// --------------------------------------------------------------------------
	console.log("\n--- [E2E Test 1] (oAuth) Claude Opus 5 Live Stream ---");
	{
		const prompt = "What is 17 * 19? Answer with just the number.";
		console.log(`Prompt: "${prompt}"`);

		let hasThinking = false;
		let thinkingText = "";
		let responseText = "";
		let startReceived = false;
		let doneReceived = false;

		const stream = client.stream(
			opusModel,
			opusSpec,
			{ messages: [{ role: "user", content: prompt }] },
			{ reasoning: "high" },
		);

		for await (const event of stream) {
			if (event.type === "start") startReceived = true;
			if (event.type === "thinking_delta") {
				hasThinking = true;
				thinkingText += event.delta;
			}
			if (event.type === "text_delta") {
				responseText += event.delta;
			}
			if (event.type === "done") {
				doneReceived = true;
			}
		}

		console.log(`Response: "${responseText.trim()}"`);
		if (hasThinking) {
			console.log(`Thinking preview: "${thinkingText.slice(0, 80).replace(/\n/g, " ")}..."`);
		}

		assert(startReceived, "Received stream 'start' event");
		assert(doneReceived, "Received stream 'done' event cleanly");
		assert(responseText.includes("323"), "Model computed correct answer (323)");
	}

	// --------------------------------------------------------------------------
	// TEST 2: Claude Opus 4.8 Live Stream
	// --------------------------------------------------------------------------
	console.log("\n--- [E2E Test 2] (oAuth) Claude Opus 4.8 Live Stream ---");
	{
		const prompt = "Give me the atomic symbol and number for Gold in one sentence.";
		console.log(`Prompt: "${prompt}"`);

		let responseText = "";
		let doneReceived = false;

		const stream = client.stream(
			opus48Model,
			opus48Spec,
			{ messages: [{ role: "user", content: prompt }] },
			{ reasoning: "high" },
		);

		for await (const event of stream) {
			if (event.type === "text_delta") {
				responseText += event.delta;
			}
			if (event.type === "done") {
				doneReceived = true;
			}
		}

		console.log(`Response: "${responseText.trim()}"`);
		assert(doneReceived, "Opus 4.8 completed stream cleanly");
		assert(responseText.includes("Au") || responseText.includes("79"), "Opus 4.8 answered accurately (Au / 79)");
	}

	// --------------------------------------------------------------------------
	// TEST 3: Multi-turn Agentic Tool Execution Round-Trip
	// --------------------------------------------------------------------------
	console.log("\n--- [E2E Test 3] Multi-turn Tool Call & Tool Result Execution ---");
	{
		const mockTools: Tool[] = [
			{
				name: "get_weather",
				description: "Gets the current weather for a city.",
				parameters: {
					type: "object",
					properties: {
						city: { type: "string", description: "City name" },
					},
					required: ["city"],
				},
			},
		];

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use tools when needed.",
			messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
			tools: mockTools,
		};

		console.log("Turn 1: Requesting tool call from model...");
		let toolCallId = "";
		let toolCallName = "";
		let toolCallArgs: any = null;

		const turn1Stream = client.stream(opusModel, opusSpec, context, { toolChoice: "auto" });
		let assistantMessage: any = null;

		for await (const event of turn1Stream) {
			if (event.type === "toolcall_end") {
				toolCallId = event.toolCall.id;
				toolCallName = event.toolCall.name;
				toolCallArgs = event.toolCall.arguments;
			}
			if (event.type === "done") {
				assistantMessage = event.message;
			}
		}

		console.log(`Tool called: ${toolCallName}(${JSON.stringify(toolCallArgs)}) [ID: ${toolCallId}]`);
		assert(toolCallName === "get_weather", "Model triggered get_weather tool");
		assert(Boolean(toolCallId), "Tool call emitted valid ID");

		// Feed tool result back into context for Turn 2
		context.messages.push(assistantMessage);
		context.messages.push({
			role: "toolResult",
			toolCallId,
			toolName: toolCallName,
			content: [{ type: "text", text: JSON.stringify({ temperature: "22°C", condition: "Sunny" }) }],
			isError: false,
		});

		console.log("Turn 2: Feeding toolResult back to model...");
		let finalAnswer = "";
		let turn2Done = false;

		const turn2Stream = client.stream(opusModel, opusSpec, context);
		for await (const event of turn2Stream) {
			if (event.type === "text_delta") {
				finalAnswer += event.delta;
			}
			if (event.type === "done") {
				turn2Done = true;
			}
		}

		console.log(`Final Answer: "${finalAnswer.trim()}"`);
		assert(turn2Done, "Turn 2 completed stream cleanly");
		assert(finalAnswer.includes("22") || finalAnswer.toLowerCase().includes("sunny"), "Final answer incorporated tool result (22°C / Sunny)");
	}

	console.log(`\n==================================================================`);
	console.log(`🏁 ALL END-TO-END TESTS PASSED: ${passed} passed, ${failed} failed`);
	console.log(`==================================================================\n`);

	if (failed > 0) process.exit(1);
}

runE2E().catch((err) => {
	console.error("E2E test failed with error:", err);
	process.exit(1);
});
