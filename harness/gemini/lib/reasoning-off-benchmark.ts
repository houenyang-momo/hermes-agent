import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CloudCodeClient } from "./client.js";
import { GeminiConversationBuilder } from "./conversation-builder.js";
import type { CloudCodeModelSpec } from "./types.js";

interface LiveTarget {
	model: Model;
	spec: CloudCodeModelSpec;
}

interface SerializedEnvelope {
	request?: {
		generationConfig?: {
			thinkingConfig?: Record<string, unknown>;
		};
	};
}

interface LiveResult {
	model: string;
	thinkingConfig: Record<string, unknown> | undefined;
	firstEventMs: number;
	firstTextMs: number;
	totalMs: number;
	eventCount: number;
	completionReason: string;
	eventTypes: string[];
	text: string;
}

const context: Context = {
	messages: [{ role: "user", content: "Reply with exactly OK." }],
};
const options: SimpleStreamOptions = {
	reasoning: "off",
	maxTokens: 256,
	temperature: 0,
};
const targets: LiveTarget[] = [
	{
		model: {
			id: "gemini-3.7-flash",
			name: "(OAuth) Gemini 3.7 Flash",
			provider: "antigravity",
			api: "google-generative-ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		},
		spec: {
			id: "gemini-3.7-flash",
			name: "(OAuth) Gemini 3.7 Flash",
			backend: "gemini-3.7-flash-tiered",
			effort: "high",
			maxTokens: 65_536,
		},
	},
	{
		model: {
			id: "gemini-3.1-pro",
			name: "(OAuth) Gemini 3.1 Pro",
			provider: "antigravity",
			api: "google-generative-ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 8192,
		},
		spec: {
			id: "gemini-3.1-pro",
			name: "(OAuth) Gemini 3.1 Pro",
			backend: "gemini-3.1-pro-low",
			effort: "high",
			maxTokens: 8192,
		},
	},
];

function wireThinkingConfig({ model, spec }: LiveTarget): Record<string, unknown> | undefined {
	const envelope = GeminiConversationBuilder.buildEnvelope(
		model,
		spec,
		context,
		options,
		"live-reasoning-check",
	);
	const serialized = JSON.parse(JSON.stringify(envelope)) as SerializedEnvelope;
	return serialized.request?.generationConfig?.thinkingConfig;
}

async function runLiveCheck(
	client: CloudCodeClient,
	{ model, spec }: LiveTarget,
): Promise<LiveResult> {
	const started = performance.now();
	let firstEventMs: number | undefined;
	let firstTextMs: number | undefined;
	let completionReason = "";
	let text = "";
	const eventTypes: string[] = [];
	const thinkingConfig = wireThinkingConfig({ model, spec });

	for await (const event of client.stream(model, spec, context, options)) {
		firstEventMs ??= performance.now() - started;
		eventTypes.push(event.type);
		if (event.type === "text_delta") {
			firstTextMs ??= performance.now() - started;
			text += event.delta;
		}
		if (event.type === "done") completionReason = event.reason;
		if (event.type === "error") throw new Error(event.error.errorMessage);
	}

	return {
		model: spec.id,
		thinkingConfig,
		firstEventMs: Number((firstEventMs ?? 0).toFixed(3)),
		firstTextMs: Number((firstTextMs ?? 0).toFixed(3)),
		totalMs: Number((performance.now() - started).toFixed(3)),
		eventCount: eventTypes.length,
		completionReason,
		eventTypes,
		text,
	};
}

const client = new CloudCodeClient();
const results: LiveResult[] = [];
for (const target of targets) results.push(await runLiveCheck(client, target));

const flash = results[0];
const pro = results[1];
if (
	JSON.stringify(flash.thinkingConfig) !==
	JSON.stringify({ thinkingBudget: 0, includeThoughts: false })
) {
	throw new Error(`Flash reasoning-off config regressed: ${JSON.stringify(flash.thinkingConfig)}`);
}
if (pro.thinkingConfig !== undefined) {
	throw new Error(`Pro reasoning-off must omit thinkingConfig: ${JSON.stringify(pro.thinkingConfig)}`);
}
for (const result of results) {
	if (result.completionReason !== "stop" || !result.text.includes("OK")) {
		throw new Error(`${result.model} live check failed: ${JSON.stringify(result)}`);
	}
}

console.log(JSON.stringify({ passed: true, results }, null, 2));
