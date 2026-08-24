/**
 * MiniMax Provider Extension for Pi Agent (OAuth & API Key).
 *
 * Provides native, zero-stall, ultra-low-latency streaming for:
 * - (oAuth) MiniMax M3 (Flagship Reasoning & Multimodal model)
 * - MiniMax-Text-01 (1M Context Long-Form Coding & Synthesis)
 * - MiniMax-VL-01 (Multimodal Vision-Language)
 * - abab6.5s-chat (High-Throughput Chat)
 *
 * Supports Dual-Seam Authentication:
 * 1. MiniMax OAuth session / bearer token
 * 2. Direct MINIMAX_API_KEY / auth.json fallback
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MiniMaxClient, type MiniMaxModelSpec } from "../lib/minimax/index.js";

const PREFERRED_MODEL_ID = "MiniMax-M3";
const OVERFLOW_PATTERN = /context.*length.*exceeded|prompt.*too long|max.*tokens.*exceeded/i;

export const MINIMAX_MODELS: MiniMaxModelSpec[] = [
	{
		id: "MiniMax-M3",
		name: "(oAuth) MiniMax M3 (Reasoning & Multimodal)",
		backend: "MiniMax-M3",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "minimax-m3",
		name: "(oAuth) MiniMax M3",
		backend: "MiniMax-M3",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "MiniMax-M2.7",
		name: "MiniMax M2.7",
		backend: "MiniMax-M2.7",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax M2.7 Highspeed",
		backend: "MiniMax-M2.7-highspeed",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "MiniMax-M2.5",
		name: "MiniMax M2.5",
		backend: "MiniMax-M2.5",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "MiniMax-M2.5-highspeed",
		name: "MiniMax M2.5 Highspeed",
		backend: "MiniMax-M2.5-highspeed",
		effort: "high",
		maxTokens: 65536,
		contextWindow: 1000000,
		supportsReasoning: true,
		supportsTools: true,
	},
	{
		id: "MiniMax-M2.1",
		name: "MiniMax M2.1",
		backend: "MiniMax-M2.1",
		effort: "off",
		maxTokens: 65536,
		contextWindow: 200000,
		supportsReasoning: false,
		supportsTools: true,
	},
	{
		id: "MiniMax-Text-01",
		name: "MiniMax Text 01 (1M Context)",
		backend: "MiniMax-Text-01",
		effort: "off",
		maxTokens: 32768,
		contextWindow: 1000000,
		supportsReasoning: false,
		supportsTools: true,
	},
];

function modelById(id: string): MiniMaxModelSpec | undefined {
	return MINIMAX_MODELS.find((m) => m.id === id || m.backend === id);
}

export default async function minimaxExtension(pi: ExtensionAPI) {
	const client = new MiniMaxClient();

	const providerConfig = {
		name: "MiniMax",
		baseUrl: "https://api.minimaxi.chat/v1",
		apiKey: "minimax-auth",
		api: "minimax-custom",
		streamSimple: (model: any, context: any, options: any) => {
			const spec = modelById(model.id) || {
				id: model.id,
				name: model.id,
				backend: model.id,
				effort: "high" as const,
				maxTokens: 65536,
				contextWindow: 1000000,
				supportsReasoning: true,
				supportsTools: true,
			};
			return client.stream(model, spec, context, options);
		},
		models: MINIMAX_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.supportsReasoning ?? false,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			thinkingLevelMap: m.supportsReasoning
				? {
					off: "off",
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "high",
					max: "high",
				}
				: {
					off: "off",
					minimal: null,
					low: null,
					medium: null,
					high: null,
					xhigh: null,
					max: null,
				},
		})),
	};

	// Register provider under "minimax", "minimax-oauth", and "minimaxi"
	pi.registerProvider("minimax", providerConfig);
	pi.registerProvider("minimax-oauth", {
		...providerConfig,
		name: "MiniMax (OAuth)",
	});
	pi.registerProvider("minimaxi", {
		...providerConfig,
		name: "MiniMax (International)",
	});

	// Normalize context overflow errors for Pi automatic compaction
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		const prov = message.provider || ctx.model?.provider;
		if (prov !== "minimax" && prov !== "minimax-oauth" && prov !== "minimaxi") return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!OVERFLOW_PATTERN.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});

	const handleCommand = async (args: string, ctx: any, prefix: string) => {
		const sub = (args || "").trim().split(/\s+/)[0] || "status";

		if (sub === "models") {
			const lines = MINIMAX_MODELS.map((m) => {
				const mark = m.id === PREFERRED_MODEL_ID ? "  <- default pick" : "";
				return `  ${m.id} (${m.name})\n    backend: ${m.backend} | reasoning: ${m.supportsReasoning} | maxTokens: ${m.maxTokens}${mark}`;
			}).join("\n");
			ctx.ui.notify(`MiniMax Models:\n${lines}`, "info");
			return;
		}

		if (sub === "auth" || sub === "status") {
			const status = await client.getStatus(PREFERRED_MODEL_ID);
			if (!status.connected) {
				ctx.ui.notify(
					`MiniMax Auth: NOT configured (${status.error || "No API key or OAuth session"}).\nSet MINIMAX_API_KEY / MINIMAX_OAUTH_TOKEN in environment or in ~/.pi/agent/auth.json, then /reload.`,
					"warn",
				);
				return;
			}

			ctx.ui.notify(
				`MiniMax Connected:\n` +
				`• Provider: minimax / minimax-oauth\n` +
				`• Auth Mode: ${status.authMode.toUpperCase()}\n` +
				`• Preferred Model: ${PREFERRED_MODEL_ID} (64k output, 1M context)\n` +
				`• Endpoint: ${status.endpoint}`,
				"info",
			);
			return;
		}

		ctx.ui.notify(`Usage: /${prefix} <status|models|auth>`, "info");
	};

	pi.registerCommand("minimax", {
		description: "MiniMax commands: status | models | auth",
		handler: async (args, ctx) => handleCommand(args, ctx, "minimax"),
	});
	pi.registerCommand("minimax-oauth", {
		description: "MiniMax OAuth commands: status | models | auth",
		handler: async (args, ctx) => handleCommand(args, ctx, "minimax-oauth"),
	});
}
