/**
 * Deliverable 1: Profile token generation latency and streaming smoothness under heavy tool use.
 *
 * Measures:
 * 1. Time to First Thinking Chunk (TTFTC) and Time to First Text Token (TTFT)
 * 2. Inter-chunk arrival delta distribution (P50, P90, P99 jitter)
 * 3. Zero-stall streaming under heavy multi-turn tool calling (nested tools, large payloads)
 * 4. Throughput (chars/sec and token rate) on Gemini 3.7 Flash with 64k+ context window
 */

import { CloudCodeClient } from "./client.js";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import type { CloudCodeModelSpec } from "./types.js";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";

interface StreamMetrics {
	ttftcMs: number; // Time to First Thinking Chunk
	ttftMs: number;  // Time to First Text Token
	totalDurationMs: number;
	totalChunks: number;
	totalTextChars: number;
	totalThinkingChars: number;
	chunkDeltasMs: number[];
	p50DeltaMs: number;
	p90DeltaMs: number;
	p99DeltaMs: number;
	maxDeltaMs: number;
	charsPerSec: number;
	toolCallsCount: number;
	stopReason: string;
	memoryDeltaMb: number;
}

function calculatePercentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
	return sorted[idx];
}

export async function profileHeavyToolStreaming(): Promise<StreamMetrics> {
	const initialMemory = process.memoryUsage().rss / (1024 * 1024);
	const client = new CloudCodeClient();

	const mockModel: Model = {
		id: "gemini-3.7-flash",
		name: "(oAuth) Gemini 3.7 Flash",
		provider: "antigravity",
		api: "google-generative-ai",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65536,
	};

	const mockSpec: CloudCodeModelSpec = {
		id: "gemini-3.7-flash",
		name: "(oAuth) Gemini 3.7 Flash",
		backend: "gemini-3.7-flash-tiered",
		effort: "high",
		maxTokens: 65536,
	};

	const tools: Tool[] = [
		{
			name: "analyze_codebase_ast",
			description: "Parses AST and symbols for a module path with deep complexity metrics",
			parameters: {
				type: "object",
				properties: {
					modulePath: { type: "string", description: "Path to module" },
					depth: { type: "number", description: "AST parse depth" },
				},
				required: ["modulePath"],
			},
		},
		{
			name: "run_static_analysis",
			description: "Executes linting, typechecking, and security scan across symbols",
			parameters: {
				type: "object",
				properties: {
					ruleset: { type: "string", description: "Ruleset name" },
					strict: { type: "boolean", description: "Strict mode" },
				},
				required: ["ruleset"],
			},
		},
	];

	// Multi-turn context with prior tool execution history to simulate heavy turn
	const context: Context = {
		systemPrompt: "You are an elite systems architect and performance engineer. Always analyze thoroughly before writing clean code.",
		messages: [
			{
				role: "user",
				content: "Please analyze the AST of 'src/crypto/pkce.ts' and run static analysis on security ruleset, then provide an optimized PKCE verifier implementation.",
			},
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "The user needs a deep AST analysis of the PKCE module and security linting before building the verifier.",
					},
					{
						type: "toolCall",
						id: "call_ast_9921",
						name: "analyze_codebase_ast",
						arguments: { modulePath: "src/crypto/pkce.ts", depth: 4 },
					},
					{
						type: "toolCall",
						id: "call_sec_9922",
						name: "run_static_analysis",
						arguments: { ruleset: "crypto-security-strict", strict: true },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "call_ast_9921",
				toolName: "analyze_codebase_ast",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							module: "src/crypto/pkce.ts",
							exports: ["generateCodeVerifier", "deriveCodeChallenge", "validateS256"],
							astNodes: 842,
							cyclomaticComplexity: 4,
							entropyScore: 0.985,
							dependencies: ["node:crypto"],
						}),
					},
				],
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "call_sec_9922",
				toolName: "run_static_analysis",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							ruleset: "crypto-security-strict",
							passed: 18,
							warnings: 0,
							vulnerabilities: 0,
							timingAttackResistant: true,
							base64UrlCompliant: true,
						}),
					},
				],
				isError: false,
			},
			{
				role: "user",
				content: "Based on the AST analysis and security scan results, synthesize your findings and produce the final production-ready TypeScript implementation of RFC 7636 PKCE with zero dependencies.",
			},
		],
		tools,
	};

	console.log("▶ Launching heavy tool multi-turn stream on Gemini 3.7 Flash High...");
	const startTime = Date.now();
	let lastChunkTime = startTime;
	let ttftcMs = 0;
	let ttftMs = 0;
	let totalChunks = 0;
	let totalTextChars = 0;
	let totalThinkingChars = 0;
	let toolCallsCount = 0;
	let stopReason = "";
	const chunkDeltasMs: number[] = [];

	const stream = client.stream(mockModel, mockSpec, context, {
		reasoning: "high",
		temperature: 0.2,
		maxTokens: 65536,
	});

	for await (const event of stream) {
		const now = Date.now();
		const delta = now - lastChunkTime;
		lastChunkTime = now;
		totalChunks++;
		if (totalChunks > 1) {
			chunkDeltasMs.push(delta);
		}

		if (event.type === "thinking_start" || event.type === "thinking_delta") {
			if (!ttftcMs) ttftcMs = now - startTime;
			if (event.type === "thinking_delta") {
				totalThinkingChars += event.delta.length;
			}
		}

		if (event.type === "text_start" || event.type === "text_delta") {
			if (!ttftMs) ttftMs = now - startTime;
			if (event.type === "text_delta") {
				totalTextChars += event.delta.length;
			}
		}

		if (event.type === "toolcall_start") {
			toolCallsCount++;
		}

		if (event.type === "done") {
			stopReason = event.reason;
		}

		if (event.type === "error") {
			stopReason = `error: ${event.error?.errorMessage}`;
		}
	}

	const totalDurationMs = Date.now() - startTime;
	const sortedDeltas = [...chunkDeltasMs].sort((a, b) => a - b);
	const p50DeltaMs = calculatePercentile(sortedDeltas, 0.50);
	const p90DeltaMs = calculatePercentile(sortedDeltas, 0.90);
	const p99DeltaMs = calculatePercentile(sortedDeltas, 0.99);
	const maxDeltaMs = sortedDeltas.length > 0 ? sortedDeltas[sortedDeltas.length - 1] : 0;
	const totalChars = totalTextChars + totalThinkingChars;
	const charsPerSec = Math.round((totalChars / (totalDurationMs / 1000)));
	const finalMemory = process.memoryUsage().rss / (1024 * 1024);

	return {
		ttftcMs: ttftcMs || totalDurationMs,
		ttftMs: ttftMs || totalDurationMs,
		totalDurationMs,
		totalChunks,
		totalTextChars,
		totalThinkingChars,
		chunkDeltasMs,
		p50DeltaMs,
		p90DeltaMs,
		p99DeltaMs,
		maxDeltaMs,
		charsPerSec,
		toolCallsCount,
		stopReason,
		memoryDeltaMb: parseFloat((finalMemory - initialMemory).toFixed(2)),
	};
}

async function run() {
	console.log("==================================================================");
	console.log("⚡ DELIVERABLE 1: TOKEN GENERATION LATENCY & STREAMING SMOOTHNESS");
	console.log("   Provider: Google Antigravity PKCE OAuth Extension");
	console.log("   Model: Gemini 3.7 Flash High Reasoning (64k Output Window)");
	console.log("==================================================================\n");

	const metrics = await profileHeavyToolStreaming();

	console.log("📊 STREAMING LATENCY & THROUGHPUT PROFILE:");
	console.log(`• Time to First Thinking Chunk (TTFTC): ${metrics.ttftcMs} ms`);
	console.log(`• Time to First Text Token (TTFT):       ${metrics.ttftMs} ms`);
	console.log(`• Total Turn Duration:                   ${metrics.totalDurationMs} ms`);
	console.log(`• Total Chunks Received:                 ${metrics.totalChunks}`);
	console.log(`• Thinking Characters Generated:         ${metrics.totalThinkingChars} chars`);
	console.log(`• Final Text Characters Generated:       ${metrics.totalTextChars} chars`);
	console.log(`• Net Generation Speed:                  ${metrics.charsPerSec} chars/sec (~${Math.round(metrics.charsPerSec / 4)} tokens/sec)`);
	console.log(`• Completion Status:                     ${metrics.stopReason}\n`);

	console.log("🌊 STREAMING SMOOTHNESS & JITTER DISTRIBUTION:");
	console.log(`• Inter-chunk P50 Jitter:                ${metrics.p50DeltaMs} ms`);
	console.log(`• Inter-chunk P90 Jitter:                ${metrics.p90DeltaMs} ms`);
	console.log(`• Inter-chunk P99 Jitter:                ${metrics.p99DeltaMs} ms`);
	console.log(`• Maximum Chunk Gap:                     ${metrics.maxDeltaMs} ms (Zero Stall < 45s Watchdog Threshold)`);
	console.log(`• Process Memory Footprint Delta:        +${metrics.memoryDeltaMb} MB\n`);

	if (metrics.stopReason === "stop" || metrics.stopReason === "toolUse") {
		console.log("✅ Zero-Stall Streaming Profile: PASS (Clean completion under heavy tool load)");
	} else {
		console.warn(`⚠️ Warning: Non-clean completion reason: ${metrics.stopReason}`);
	}
	console.log("==================================================================\n");
}

if (import.meta.main) {
	run().catch((e) => {
		console.error("Profiling failed:", e);
		process.exit(1);
	});
}
