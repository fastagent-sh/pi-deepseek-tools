import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Key } from "@earendil-works/pi-tui";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PRICE_PER_CALL_YUAN, findApiKey, type DeepSeekClient } from "./deepseek.ts";

const STATUS_KEY = "deepseek";
const TOOL_NAMES = ["deepseek_search", "deepseek_fetch"];
const USAGE = "Usage: /deepseek-tools [on|off|toggle|status|test]";
const ACTIONS = [
	{ action: "on", label: "Enable the tools; every successful call is billed" },
	{ action: "off", label: "Disable the tools for this session" },
	{ action: "status", label: "Key source, defaults and session spend" },
	{ action: "test", label: "Run one search and report latency and cost" },
] as const;

let enabled = true;
let calls = 0;

export function isEnabled(): boolean {
	return enabled;
}

export async function startSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	calls = 0;
	enabled = await isEnabledByDefault();
	if (!enabled) applyActiveTools(pi, false);
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
		description: "DeepSeek Search and Fetch: on/off, key source, connection test",
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
			if (rest.length > 0 || (action !== undefined && action !== "toggle" && !ACTIONS.some((entry) => entry.action === action))) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			switch (action) {
				case "on":
					setEnabled(pi, true, ctx);
					return;
				case "off":
					setEnabled(pi, false, ctx);
					return;
				case "toggle":
					setEnabled(pi, !enabled, ctx);
					return;
				case "test":
					await testConnection(client, ctx);
					return;
				default:
					ctx.ui.notify(statusLine(), "info");
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("d"), {
		description: "Toggle DeepSeek tools",
		handler: (ctx) => setEnabled(pi, !enabled, ctx),
	});
}

function setEnabled(pi: ExtensionAPI, next: boolean, ctx: ExtensionContext): void {
	enabled = next;
	applyActiveTools(pi, next);
	refreshStatus(ctx);
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		next
			? "DeepSeek tools on. Every successful search or fetch bills ¥5 per 1,000 requests."
			: "DeepSeek tools off. The model cannot call them and nothing is billed.",
		next ? "warning" : "info",
	);
}

function applyActiveTools(pi: ExtensionAPI, active: boolean): void {
	const others = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
	pi.setActiveTools(active ? [...others, ...TOOL_NAMES] : others);
}

function statusLine(): string {
	const info = findApiKey();
	const spend = calls > 0 ? `${calls} call${calls === 1 ? "" : "s"} · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}` : "no calls";
	const state = enabled ? "on" : "off";
	if (!info) return `DeepSeek tools · ${state} · no key: run /login deepseek, or set DEEPSEEK_API_KEY · ${spend}`;
	return `DeepSeek tools · ${state} · key: ${info.source} (${maskKey(info.key)}) · 5 results by default · ${spend}`;
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
		ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "deepseek no key · /login deepseek"));
		return;
	}
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", "deepseek off"));
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEY,
		theme.fg("dim", calls === 0 ? "deepseek on" : `deepseek on · ¥${yuan(calls * PRICE_PER_CALL_YUAN)}`),
	);
}

async function isEnabledByDefault(settingsPath = join(getAgentDir(), "settings.json")): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf-8"));
		const section = isRecord(parsed) ? parsed["deepseek-tools"] : undefined;
		return !(isRecord(section) && section.enabledByDefault === false);
	} catch {
		return true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskKey(key: string): string {
	return key.length <= 12 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function yuan(amount: number): string {
	return amount.toFixed(3);
}
