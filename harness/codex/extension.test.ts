import { expect, mock, test } from "bun:test";
import { ProviderQuotaStore } from "../common/quota-store.js";

mock.module("@earendil-works/pi-tui", () => ({
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
}));

mock.module("@earendil-works/pi-ai", () => ({
	createAssistantMessageEventStream: () => ({ push() {}, end() {} }),
	streamSimple: () => ({ push() {}, end() {} }),
}));

test("registers a detailed Codex usage command", async () => {
	const { default: antigravityExtension } = await import("../../extensions/antigravity.js");
	const commands = new Map<string, unknown>();
	const pi = {
		registerProvider() {},
		on() {},
		registerCommand(name: string, options: unknown) {
			commands.set(name, options);
		},
	};

	await antigravityExtension(pi as any);
	expect(commands.has("codex")).toBe(true);
});

test("renders both Codex buckets and the OAuth provider label in the footer", async () => {
	const { default: antigravityExtension } = await import("../../extensions/antigravity.js");
	const events = new Map<string, (...args: any[]) => unknown>();
	let footerFactory: any;
	const pi = {
		registerProvider() {},
		registerCommand() {},
		on(name: string, handler: (...args: any[]) => unknown) {
			events.set(name, handler);
		},
	};
	await antigravityExtension(pi as any);

	ProviderQuotaStore.get().updateFromCodexSnapshot({
		ok: true,
		fetchedAt: Date.now(),
		general: { remainingPct: 24, windowSeconds: 604800, resetAt: 1787201127 },
		spark: { remainingPct: 100, windowSeconds: 604800, resetAt: 1787764998 },
	});
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 1_000_000 },
		thinkingLevel: "max",
		modelRegistry: {
			isUsingOAuth: () => true,
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => ({ ok: false, error: "not needed in render assertion" }),
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ percent: 12.5, contextWindow: 1_000_000 }),
		ui: {
			setFooter(factory: unknown) {
				footerFactory = factory;
			},
		},
	};
	await events.get("session_start")?.({}, ctx);
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text },
		{
			getGitBranch: () => null,
			onBranchChange: () => () => {},
		},
	);
	const lines = footer.render(200);
	expect(lines[1]).toContain("⚡ GPT5.6 wk: 24% rem");
	expect(lines[1]).toContain("GPT5.3: 100% rem");
	expect(lines[1]).toContain("(oAuth) gpt-5.6-sol • max");
});
