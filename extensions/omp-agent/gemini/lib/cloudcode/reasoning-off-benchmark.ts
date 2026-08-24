import { CloudCodeClient } from "./client.js";
import type { CloudCodeModelSpec } from "./types.js";
import type { Context, Model } from "@earendil-works/pi-ai";

const model: Model = {
	id: "gemini-3.7-flash",
	name: "(OAuth) Gemini 3.7 Flash",
	provider: "antigravity",
	api: "google-generative-ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};
const spec: CloudCodeModelSpec = {
	id: "gemini-3.7-flash",
	name: "(OAuth) Gemini 3.7 Flash",
	backend: "gemini-3.7-flash-tiered",
	effort: "high",
	maxTokens: 65_536,
};
const context: Context = {
	messages: [{ role: "user", content: "Reply with exactly OK." }],
};

const client = new CloudCodeClient();
const started = performance.now();
let firstEventMs: number | undefined;
let firstTextMs: number | undefined;
let eventCount = 0;
let completionReason = "";
let text = "";
const eventTypes: string[] = [];
for await (const event of client.stream(model, spec, context, {
	reasoning: "off",
	maxTokens: 64,
	temperature: 0,
})) {
	firstEventMs ??= performance.now() - started;
	eventCount += 1;
	eventTypes.push(event.type);
	if (event.type === "text_delta") {
		firstTextMs ??= performance.now() - started;
		text += event.delta;
	}
	if (event.type === "done") completionReason = event.reason;
	if (event.type === "error") throw new Error(event.error.errorMessage);
}
console.log(JSON.stringify({
	firstEventMs: Number((firstEventMs ?? 0).toFixed(3)),
	firstTextMs: Number((firstTextMs ?? 0).toFixed(3)),
	totalMs: Number((performance.now() - started).toFixed(3)),
	eventCount,
	completionReason,
	eventTypes,
	text,
}, null, 2));
