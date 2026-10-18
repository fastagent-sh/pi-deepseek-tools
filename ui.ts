import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PRICE_PER_CALL_YUAN,
	findApiKey,
	webSearchConfigPath,
	type DeepSeekClient,
} from "./deepseek.ts";

const STATUS_KEY = "deepseek";
const NOT_FOUND = "No key configured. /deepseek key · default 5 results · ¥5 per 1,000 requests";

const ACTIONS = [
	{ action: "status", label: "Show status and key source" },
	{ action: "key", label: "Set the API key" },
	{ action: "test", label: "Test the connection" },
	{ action: "help", label: "Show help" },
] as const;

let calls = 0;

export function resetSessionStatus(ctx: ExtensionContext | undefined): void {
	calls = 0;
	refreshStatus(ctx);
}

export function clearSessionStatus(ctx: ExtensionContext | undefined): void {
	calls = 0;
	if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function recordCall(ctx: ExtensionContext | undefined): void {
	calls += 1;
	refreshStatus(ctx);
}

export function registerDeepSeekCommand(pi: ExtensionAPI, client: DeepSeekClient): void {
	pi.registerCommand("deepseek", {
		description: "DeepSeek web tools: status, API key, connection test",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			return ACTIONS.filter(({ action }) => action.startsWith(typed)).map(({ action, label }) => ({
				value: action,
				label: action,
				description: label,
			}));
		},
		handler: async (args, ctx) => {
			const typed = args.trim().toLowerCase();
			if (!typed) {
				const choice = await ctx.ui.select(
					"DeepSeek",
					ACTIONS.map(({ label }) => label),
				);
				const picked = ACTIONS.find(({ label }) => label === choice);
				if (picked) await run(picked.action, client, ctx);
				return;
			}
			await run(typed, client, ctx);
		},
	});
}

async function run(action: string, client: DeepSeekClient, ctx: ExtensionCommandContext): Promise<void> {
	switch (action) {
		case "status":
			ctx.ui.notify(statusLine(), "info");
			return;
		case "key":
			await setKey(ctx);
			return;
		case "test":
			await testConnection(client, ctx);
			return;
		case "help":
			ctx.ui.notify(
				"/deepseek status · /deepseek key · /deepseek test · key from DEEPSEEK_API_KEY, pi auth, or web-search.json",
				"info",
			);
			return;
		default:
			ctx.ui.notify(`Unknown argument "${action}". Try status, key, test, or help.`, "warning");
	}
}

function statusLine(): string {
	const info = findApiKey();
	const spend = calls > 0 ? `${calls} call${calls === 1 ? "" : "s"} · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}` : "no calls";
	if (!info) return NOT_FOUND;
	return `key: ${info.source} (${maskKey(info.key)}) · default 5 results · ${spend}`;
}

async function setKey(ctx: ExtensionCommandContext): Promise<void> {
	const path = webSearchConfigPath();
	const config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				ctx.ui.notify(`${path} does not hold a JSON object. Fix or remove it, then run /deepseek key again.`, "error");
				return;
			}
			Object.assign(config, parsed);
		} catch (error) {
			ctx.ui.notify(`Cannot parse ${path}: ${(error as Error).message}`, "error");
			return;
		}
	}
	const answer = await ctx.ui.input("DeepSeek API key", "sk-… · saved to web-search.json");
	if (answer === undefined) return;
	const key = answer.trim();
	if (key.length < 20) {
		ctx.ui.notify("That does not look like a DeepSeek API key. Nothing was saved.", "warning");
		return;
	}
	writeFileSync(path, `${JSON.stringify({ ...config, deepseekApiKey: key }, null, 2)}\n`, { mode: 0o600 });
	// An existing file keeps its old permissions, which may be world-readable.
	chmodSync(path, 0o600);
	refreshStatus(ctx);

	const info = findApiKey();
	if (info?.source === "web-search.json") {
		ctx.ui.notify(`Saved to ${path}. Run /deepseek test to verify.`, "info");
		return;
	}
	ctx.ui.notify(
		`Saved to ${path}, but ${info?.source ?? "another source"} takes precedence. Remove that key to use this one.`,
		"warning",
	);
}

async function testConnection(client: DeepSeekClient, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Testing DeepSeek...", "info");
	const started = Date.now();
	try {
		const results = await client.search({ query: "deepseek", count: 1 });
		recordCall(ctx);
		ctx.ui.notify(
			`Key works: ${results.length} result in ${Date.now() - started}ms · ¥${yuan(PRICE_PER_CALL_YUAN)}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`DeepSeek test failed: ${(error as Error).message}`, "error");
	}
}

function refreshStatus(ctx: ExtensionContext | undefined): void {
	if (!ctx?.hasUI) return;
	const theme = ctx.ui.theme;
	// The status line is decoration around a tool call; a UI without a theme must not fail the call.
	if (typeof theme?.fg !== "function") return;
	let found = true;
	try {
		found = Boolean(findApiKey());
	} catch {
		found = false;
	}
	if (!found) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "deepseek · no api key · /deepseek key"));
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEY,
		calls === 0 ? undefined : theme.fg("dim", `deepseek · ${calls} call${calls === 1 ? "" : "s"} · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}`),
	);
}

function maskKey(key: string): string {
	return key.length <= 12 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function yuan(amount: number): string {
	return amount.toFixed(3);
}
