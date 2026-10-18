import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import type { DeepSeekClient, SearchResult } from "../deepseek.ts";
import { DeepSeekError } from "../deepseek.ts";
import {
	clearSessionStatus,
	formatStatus,
	isEnabled,
	recordCall,
	registerDeepSeekCommand,
	startSession,
} from "../commands.ts";

const TOOL_NAMES = ["deepseek_search", "deepseek_fetch"];

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function sampleHits(): SearchResult[] {
	return Array.from({ length: 3 }, (_, index) => ({
		title: `Result ${index + 1}`,
		url: `https://example${index + 1}.com/page`,
		snippet: "short summary",
		summary: "long summary text that only the expanded view shows",
		content: "",
		siteName: "Example",
		date: null,
		score: 2.5,
		authority: 3,
	}));
}

function registerTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	extension({
		on: () => () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		getActiveTools: () => [...TOOL_NAMES],
		setActiveTools: () => {},
	} as unknown as ExtensionAPI);
	return tools;
}

function render(component: unknown, width = 120): string {
	return (component as Text).render(width).join("\n");
}

const renderContext = { isError: false } as never;
const partial = { expanded: false, isPartial: false };

test("search call and result render a compact summary, with the body on expand", () => {
	const tool = registerTools().get("deepseek_search");
	assert.ok(tool?.renderCall && tool.renderResult);

	assert.match(render(tool.renderCall({ query: "deepseek v4", count: 5 }, theme, undefined as never)), /deepseek_search\s+"deepseek v4" · 5/);

	const result = {
		content: [{ type: "text", text: "1. Result 1\nhttps://example1.com/page\nlong summary text that only the expanded view shows" }],
		details: {
			query: "deepseek v4",
			count: 3,
			includeContent: false,
			durationMs: 420,
			top: sampleHits().map((hit) => ({ title: hit.title, host: new URL(hit.url).hostname })),
		},
	};

	const collapsed = render(tool.renderResult(result as never, partial, theme, renderContext));
	assert.match(collapsed, /3 results · 0\.4s/);
	assert.match(collapsed, /1\. Result 1 · example1\.com/);
	assert.doesNotMatch(collapsed, /long summary/);

	const expanded = render(tool.renderResult(result as never, { ...partial, expanded: true }, theme, renderContext));
	assert.match(expanded, /long summary/);
});

test("fetch renderers show the title, size and truncation, and the body on expand", () => {
	const tool = registerTools().get("deepseek_fetch");
	assert.ok(tool?.renderCall && tool.renderResult);

	assert.match(render(tool.renderCall({ url: "https://example.com/page" }, theme, undefined as never)), /deepseek_fetch\s+https:\/\/example\.com\/page/);

	const result = {
		content: [{ type: "text", text: "# Title\n\nbody line one\nbody line two" }],
		details: { url: "https://example.com/page", title: "Title", bytes: 133_000, truncated: true, durationMs: 3200 },
	};

	const collapsed = render(tool.renderResult(result as never, partial, theme, renderContext));
	assert.match(collapsed, /Title · 129\.9KB · truncated/);

	const expanded = render(tool.renderResult(result as never, { ...partial, expanded: true }, theme, renderContext));
	assert.match(expanded, /body line two/);
});

test("an error result renders the error line", () => {
	const tool = registerTools().get("deepseek_search");
	assert.ok(tool?.renderResult);
	const result = { content: [{ type: "text", text: "POST /v1/tools/search failed with HTTP 401: bad key" }], details: undefined };
	const rendered = render(tool.renderResult(result as never, partial, theme, { isError: true } as never));
	assert.match(rendered, /HTTP 401: bad key/);
});

interface Harness {
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
	notices: Array<{ message: string; type: string }>;
	statuses: Map<string, string | undefined>;
	active: () => string[];
	command: RegisteredCommand;
	shortcuts: Map<string, (ctx: ExtensionCommandContext) => void>;
	run: (args: string) => Promise<void>;
}

const STATUS_KEY = "deepseek-tools";
const LABEL = "deepseek-tools(search/fetch)";
const ICON = "🐳";

function commandHarness(options: { client?: DeepSeekClient; activeTools?: string[] } = {}): Harness {
	const notices: Array<{ message: string; type: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const shortcuts = new Map<string, (ctx: ExtensionCommandContext) => void>();
	let active = [...(options.activeTools ?? ["read", ...TOOL_NAMES])];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme,
			notify: (message: string, type: "info" | "warning" | "error" = "info") => notices.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
		},
	} as unknown as ExtensionCommandContext;
	let command: RegisteredCommand | undefined;
	const pi = {
		registerCommand: (_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			command = definition as RegisteredCommand;
		},
		registerShortcut: (key: string, definition: { handler: (ctx: ExtensionCommandContext) => void }) =>
			shortcuts.set(key, definition.handler),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	registerDeepSeekCommand(pi, options.client ?? ({} as DeepSeekClient));
	return {
		ctx,
		pi,
		notices,
		statuses,
		active: () => active,
		command: command!,
		shortcuts,
		run: (args: string) => command!.handler(args, ctx),
	};
}

function isolateEnv(settings?: unknown): { dir: string; restore: () => void } {
	const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, key: process.env.DEEPSEEK_API_KEY };
	const dir = mkdtempSync(join(tmpdir(), "pi-deepseek-ui-"));
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.DEEPSEEK_API_KEY;
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	return {
		dir,
		restore: () => {
			process.env.HOME = saved.home;
			if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
			if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = saved.key;
		},
	};
}

test("/deepseek-tools status reports the label, state and key source without printing the key", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-abcdef0123456789abcdef";
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		await harness.run("status");
		const message = harness.notices.at(-1)!.message;
		assert.match(message, /^deepseek-tools\(search\/fetch\) · on · key: DEEPSEEK_API_KEY \(sk-…cdef\)/);
		assert.doesNotMatch(message, /sk-abcdef0123456789abcdef/);
	} finally {
		env.restore();
	}
});

test("a bare /deepseek-tools toggles the tools instead of asking for a subcommand", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness({ activeTools: ["read", ...TOOL_NAMES] });
		await startSession(harness.pi, harness.ctx);
		await harness.run("");
		assert.equal(isEnabled(), false);
		assert.deepEqual(harness.active(), ["read"]);
		assert.equal(harness.notices.at(-1)!.message, `${LABEL} off. The model cannot call them and nothing is billed.`);

		await harness.run("");
		assert.equal(isEnabled(), true);
		assert.deepEqual(harness.active(), ["read", ...TOOL_NAMES]);
		assert.equal(harness.notices.at(-1)!.type, "warning");
		assert.match(harness.notices.at(-1)!.message, /bills ¥5 per 1,000 requests/);

		await harness.run("");
		await harness.run("");
		assert.deepEqual(harness.active(), ["read", ...TOOL_NAMES], "toggling twice must not duplicate names");
	} finally {
		env.restore();
	}
});

test("the ctrl+shift+d shortcut toggles the same state", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		harness.shortcuts.get("ctrl+shift+d")!(harness.ctx);
		assert.equal(isEnabled(), false);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} off`);
		harness.shortcuts.get("ctrl+shift+d")!(harness.ctx);
		assert.equal(isEnabled(), true);
	} finally {
		env.restore();
	}
});

test("a disabled session starts with the tools removed and the footer saying so", async () => {
	const env = isolateEnv({ "deepseek-tools": { enabledByDefault: false } });
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness({ activeTools: ["read", ...TOOL_NAMES] });
		await startSession(harness.pi, harness.ctx);
		assert.equal(isEnabled(), false);
		assert.deepEqual(harness.active(), ["read"]);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} off`);
	} finally {
		env.restore();
	}
});

test("a disabled toggle blocks the tools before any request is made", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const tools = new Map<string, ToolDefinition>();
		let command: RegisteredCommand | undefined;
		const pi = {
			on: () => () => {},
			registerCommand: (_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				command = definition as RegisteredCommand;
			},
			registerShortcut: () => {},
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			getActiveTools: () => [...TOOL_NAMES],
			setActiveTools: () => {},
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = { hasUI: false } as unknown as ExtensionCommandContext;
		await startSession(pi, ctx);
		await command!.handler("", ctx);
		await assert.rejects(
			tools.get("deepseek_search")!.execute("c", { query: "x" }, undefined, undefined, {} as never),
			/DeepSeek tools are off/,
		);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools rejects unknown arguments with its usage line", async () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		await harness.run("on");
		assert.equal(harness.notices.at(-1)!.type, "warning");
		assert.match(
			harness.notices.at(-1)!.message,
			/^Usage: \/deepseek-tools \[status\|test\] · no argument toggles the tools$/,
		);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools points at a missing key without writing anything", async () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		await harness.run("status");
		assert.match(harness.notices.at(-1)!.message, /no key: run \/login deepseek, or set DEEPSEEK_API_KEY/);
		assert.equal(existsSync(join(env.dir, "web-search.json")), false);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools test reports success and the session spend", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const client = {
			search: async () => sampleHits().slice(0, 1),
			fetchPage: async () => {
				throw new Error("unused");
			},
		} as unknown as DeepSeekClient;
		const harness = commandHarness({ client });
		await startSession(harness.pi, harness.ctx);
		await harness.run("test");
		assert.match(harness.notices.at(-1)!.message, /DeepSeek works: 1 result in \d+ms · ¥0\.005/);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} on · ¥0.005`);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools test surfaces the API error", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const client = {
			search: async () => {
				throw new DeepSeekError("POST /v1/tools/search failed with HTTP 401: bad key", 401);
			},
		} as unknown as DeepSeekClient;
		const harness = commandHarness({ client });
		await startSession(harness.pi, harness.ctx);
		await harness.run("test");
		assert.equal(harness.notices.at(-1)!.type, "error");
		assert.match(harness.notices.at(-1)!.message, /HTTP 401: bad key/);
	} finally {
		env.restore();
	}
});

test("footer text names the tools, the state and the spend", async () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} no key · /login deepseek`);

		process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
		await startSession(harness.pi, harness.ctx);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} on`);
		recordCall(harness.ctx);
		recordCall(harness.ctx);
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} on · ¥0.010`);
	} finally {
		env.restore();
	}
});

test("the footer adds the product name only on a wide terminal", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		assert.equal(formatStatus(80), `${ICON} on`);
		assert.equal(formatStatus(140), `${ICON} DeepSeek Tools on`);

		recordCall(harness.ctx);
		assert.equal(formatStatus(80), `${ICON} on · ¥0.005`);
		assert.equal(formatStatus(140), `${ICON} DeepSeek Tools on · ¥0.005`);

		await harness.run("");
		assert.equal(formatStatus(80), `${ICON} off`);
		assert.equal(formatStatus(140), `${ICON} DeepSeek Tools off`);
	} finally {
		env.restore();
	}
});

test("a terminal resize refreshes the footer", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness();
		await startSession(harness.pi, harness.ctx);
		harness.statuses.clear();
		process.stdout.emit("resize");
		assert.equal(harness.statuses.get(STATUS_KEY), `${ICON} on`);

		clearSessionStatus(harness.ctx);
		harness.statuses.clear();
		process.stdout.emit("resize");
		assert.equal(harness.statuses.size, 0, "the resize listener must be removed at shutdown");
	} finally {
		env.restore();
	}
});

test("/deepseek-tools completes status and test", async () => {
	const harness = commandHarness();
	const completions = await harness.command.getArgumentCompletions!("");
	assert.deepEqual(completions?.map((item) => item.value), ["status", "test"]);
});
