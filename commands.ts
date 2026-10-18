import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PRICE_PER_CALL_YUAN, findApiKey, type DeepSeekClient } from "./deepseek.ts";

const STATUS_KEY = "deepseek";
const USAGE = "Usage: /deepseek-tools [status|test] · key from /login deepseek or DEEPSEEK_API_KEY";
const ACTIONS = [
	{ action: "status", label: "Show the key source, defaults and session spend" },
	{ action: "test", label: "Run one search and report latency and cost" },
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
	pi.registerCommand("deepseek-tools", {
		description: "DeepSeek Search and Fetch: key source, defaults, connection test",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			return ACTIONS.filter(({ action }) => action.startsWith(typed)).map(({ action, label }) => ({
				value: action,
				label: action,
				description: label,
			}));
		},
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (rest.length > 0 || (action !== undefined && !ACTIONS.some((entry) => entry.action === action))) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (action === "test") {
				await testConnection(client, ctx);
				return;
			}
			ctx.ui.notify(statusLine(), "info");
		},
	});
}

function statusLine(): string {
	const info = findApiKey();
	const spend = calls > 0 ? `${calls} call${calls === 1 ? "" : "s"} · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}` : "no calls";
	if (!info) return `DeepSeek tools · no key: run /login deepseek, or set DEEPSEEK_API_KEY · ${spend}`;
	return `DeepSeek tools · key: ${info.source} (${maskKey(info.key)}) · 5 results by default · ${spend}`;
}

async function testConnection(client: DeepSeekClient, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Testing DeepSeek...", "info");
	const started = Date.now();
	try {
		const results = await client.search({ query: "deepseek", count: 1 });
		recordCall(ctx);
		ctx.ui.notify(
			`DeepSeek works: ${results.length} result in ${Date.now() - started}ms · ¥${yuan(PRICE_PER_CALL_YUAN)}`,
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
		ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "deepseek · no api key · /login deepseek"));
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEY,
		calls === 0
			? undefined
			: theme.fg("dim", `deepseek · ${calls} call${calls === 1 ? "" : "s"} · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}`),
	);
}

function maskKey(key: string): string {
	return key.length <= 12 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function yuan(amount: number): string {
	return amount.toFixed(3);
}
