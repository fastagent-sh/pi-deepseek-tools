import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

function register(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	extension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	return tools;
}

test("registers the two DeepSeek tools", () => {
	const tools = register();
	assert.deepEqual([...tools.keys()], ["deepseek_search", "deepseek_fetch"]);
	assert.ok(tools.get("deepseek_search")?.outputSchema);
	assert.ok(tools.get("deepseek_fetch")?.outputSchema);
	assert.equal(tools.get("deepseek_search")?.exposure ?? "direct", "direct");
});

test("reports a missing API key instead of failing silently", async () => {
	const savedHome = process.env.HOME;
	const savedKey = process.env.DEEPSEEK_API_KEY;
	process.env.HOME = mkdtempSync(join(tmpdir(), "pi-deepseek-home-"));
	delete process.env.DEEPSEEK_API_KEY;
	try {
		const tool = register().get("deepseek_search");
		assert.ok(tool);
		await assert.rejects(
			tool.execute("call-1", { query: "q" }, undefined, undefined, {} as never),
			/DEEPSEEK_API_KEY/,
		);
	} finally {
		process.env.HOME = savedHome;
		if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
	}
});
