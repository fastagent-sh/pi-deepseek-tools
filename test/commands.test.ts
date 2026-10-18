import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
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
import { recordCall, registerDeepSeekCommand, resetSessionStatus } from "../commands.ts";

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
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
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

function commandHarness(options: { client?: DeepSeekClient } = {}) {
	const notices: Array<{ message: string; type: string }> = [];
	const statuses = new Map<string, string | undefined>();
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
	registerDeepSeekCommand(
		{
			registerCommand: (_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				command = definition as RegisteredCommand;
			},
		} as unknown as ExtensionAPI,
		options.client ?? ({} as DeepSeekClient),
	);
	return { ctx, notices, statuses, run: (args: string) => command!.handler(args, ctx), command: command! };
}

function isolateEnv(): { dir: string; restore: () => void } {
	const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, key: process.env.DEEPSEEK_API_KEY };
	const dir = mkdtempSync(join(tmpdir(), "pi-deepseek-ui-"));
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.DEEPSEEK_API_KEY;
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

test("/deepseek-tools status reports the key source without printing the key", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-abcdef0123456789abcdef";
	try {
		const harness = commandHarness();
		await harness.run("status");
		const message = harness.notices[0].message;
		assert.match(message, /key: DEEPSEEK_API_KEY \(sk-…cdef\)/);
		assert.doesNotMatch(message, /sk-abcdef0123456789abcdef/);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools sends a bare call and status to the same line", async () => {
	const env = isolateEnv();
	process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
	try {
		const harness = commandHarness();
		await harness.run("");
		assert.match(harness.notices[0].message, /^DeepSeek tools · key: DEEPSEEK_API_KEY/);
		await harness.run("status");
		assert.equal(harness.notices.at(-1)!.message, harness.notices[0].message);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools points at a missing key without writing anything", async () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		await harness.run("status");
		assert.match(harness.notices[0].message, /no key: run \/login deepseek, or set DEEPSEEK_API_KEY/);
		assert.equal(existsSync(join(env.dir, "web-search.json")), false);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools rejects unknown arguments with its usage line", async () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		await harness.run("key sk-123");
		assert.equal(harness.notices.at(-1)!.type, "warning");
		assert.match(harness.notices.at(-1)!.message, /^Usage: \/deepseek-tools \[status\|test\]/);
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
		await harness.run("test");
		assert.match(harness.notices.at(-1)!.message, /DeepSeek works: 1 result in \d+ms · ¥0\.005/);
		assert.match(harness.statuses.get("deepseek") ?? "", /1 call · ¥0\.005/);
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
		await harness.run("test");
		assert.equal(harness.notices.at(-1)!.type, "error");
		assert.match(harness.notices.at(-1)!.message, /HTTP 401: bad key/);
	} finally {
		env.restore();
	}
});

test("session status counts calls and points a missing key at /login", () => {
	const env = isolateEnv();
	try {
		const harness = commandHarness();
		resetSessionStatus(harness.ctx);
		assert.match(harness.statuses.get("deepseek") ?? "", /deepseek · no api key · \/login deepseek/);

		process.env.DEEPSEEK_API_KEY = "sk-0123456789abcdefghij";
		resetSessionStatus(harness.ctx);
		assert.equal(harness.statuses.get("deepseek"), undefined);
		recordCall(harness.ctx);
		recordCall(harness.ctx);
		assert.match(harness.statuses.get("deepseek") ?? "", /2 calls · ¥0\.010/);
	} finally {
		env.restore();
	}
});

test("/deepseek-tools completes its subcommands", async () => {
	const harness = commandHarness();
	const completions = await harness.command.getArgumentCompletions!("s");
	assert.deepEqual(completions?.map((item) => item.value), ["status"]);
});
