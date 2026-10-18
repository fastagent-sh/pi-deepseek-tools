import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createDeepSeekClient,
	DeepSeekError,
	formatFetchedPage,
	formatSearchResults,
	type FetchedPage,
} from "./deepseek.ts";
import {
	clearSessionStatus,
	recordCall,
	registerDeepSeekCommand,
	startSession,
	isEnabled,
} from "./commands.ts";

const client = createDeepSeekClient();

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

const searchParameters = Type.Object({
	query: Type.String({
		description: "Search query, 1-128 Unicode characters. Search operators are passed through unchanged.",
	}),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Number of results (default 5)" })),
	includeContent: Type.Optional(
		Type.Boolean({
			description:
				"Also return extracted page text for every result (default false). Costs context; prefer deepseek_fetch for a single page.",
		}),
	),
});

const fetchParameters = Type.Object({
	url: Type.String({ description: "HTTP(S) URL with a host, no credentials, at most 8192 characters" }),
});

const searchOutputSchema = Type.Object({
	results: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
			summary: Type.String(),
			content: Type.String(),
			siteName: NullableString,
			date: NullableString,
			score: NullableNumber,
			authority: NullableNumber,
		}),
	),
});

const fetchOutputSchema = Type.Object({
	url: Type.String(),
	title: Type.String(),
	content: Type.String(),
	truncated: Type.Boolean(),
	fullContentPath: NullableString,
});

type SearchDetails = {
	query: string;
	count: number;
	includeContent: boolean;
	durationMs: number;
	// The TUI renderer receives content and details only, so the preview lives here.
	top: Array<{ title: string; host: string }>;
};
type FetchDetails = { url: string; title: string; bytes: number; truncated: boolean; durationMs: number };

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => startSession(pi, ctx));
	pi.on("session_shutdown", (_event, ctx) => clearSessionStatus(ctx));
	registerDeepSeekCommand(pi, client);

	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description:
			"Search the web with DeepSeek's search API and return ranked results (title, URL, long summary, site, date, quality score). " +
			"Query operators are passed through: site:example.com, -site:example.com, -word, -\"exact phrase\", \"exact phrase\", lang:zh,en, after:2025-01-01, before:2026-06-01. " +
			"Use deepseek_fetch to read one result in full.",
		parameters: searchParameters,
		outputSchema: searchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true },
		promptSnippet: "Search the web through DeepSeek Search",
		namespace: { name: "deepseek", description: "DeepSeek web search and page fetch APIs" },

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("deepseek_search ")) + theme.fg("accent", `"${clip(args.query, 60)}"`);
			if (args.count !== undefined) text += theme.fg("dim", ` · ${args.count}`);
			if (args.includeContent) text += theme.fg("dim", " · with content");
			return new Text(text, 0, 0);
		},

			renderResult(result, { expanded }, theme, context) {
			if (context.isError) return new Text(theme.fg("error", clip(firstLine(textOf(result)), 160)), 0, 0);
			const details = result.details as SearchDetails | undefined;
			const count = details?.count ?? 0;
			const header = [
				count === 0 ? theme.fg("muted", "no results") : theme.fg("success", `${count} result${count === 1 ? "" : "s"}`),
				details?.durationMs !== undefined ? theme.fg("dim", ` · ${(details.durationMs / 1000).toFixed(1)}s`) : "",
			].join("");
			if (expanded) return new Text(`${header}\n${theme.fg("toolOutput", textOf(result))}`, 0, 0);

			const lines = (details?.top ?? []).map(
				(hit, index) => theme.fg("muted", `${index + 1}. `) + theme.fg("dim", clip(`${hit.title} · ${hit.host}`, 96)),
			);
			return new Text([header, ...lines].join("\n"), 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!isEnabled()) throw new DeepSeekError("DeepSeek tools are off. Run /deepseek-tools on to enable them.");
			const started = Date.now();
			const includeContent = params.includeContent ?? false;
			const results = await client.search({
				query: params.query,
				count: params.count,
				includeContent,
				signal,
			});
			recordCall(ctx);
			const output = truncateHead(formatSearchResults(results, includeContent));
			const text = output.truncated
				? `${output.content}\n\n[Output truncated at ${describeLimit(output.truncatedBy)}. Fetch individual URLs with deepseek_fetch to read them.]`
				: output.content;
			const details: SearchDetails = {
				query: params.query,
				count: results.length,
				includeContent,
				durationMs: Date.now() - started,
				top: results.slice(0, 3).map((hit) => ({ title: hit.title, host: hostOf(hit.url) })),
			};
			return {
				content: [{ type: "text", text }],
				details,
				structuredContent: { results },
			};
		},
	});

	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek Fetch",
		description:
			"Fetch one web page with DeepSeek's fetch API and return its title plus Markdown body. " +
			`Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines; oversized pages are written to a temp file.`,
		parameters: fetchParameters,
		outputSchema: fetchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true },
		promptSnippet: "Fetch one URL as Markdown through DeepSeek Fetch",
		namespace: { name: "deepseek", description: "DeepSeek web search and page fetch APIs" },

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("deepseek_fetch ")) + theme.fg("accent", clip(args.url, 100)), 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			if (context.isError) return new Text(theme.fg("error", clip(firstLine(textOf(result)), 160)), 0, 0);
			const details = result.details as FetchDetails | undefined;
			const header = [
				theme.fg("success", clip(details?.title || hostOf(details?.url ?? ""), 80)),
				details ? theme.fg("dim", ` · ${formatSize(details.bytes)}`) : "",
				details?.truncated ? theme.fg("warning", " · truncated") : "",
			].join("");
			if (!expanded) return new Text(header, 0, 0);

			const lines = textOf(result).split("\n");
			const shown = lines.slice(0, 40);
			const more = lines.length > shown.length ? `\n${theme.fg("muted", `… ${lines.length - shown.length} more lines`)}` : "";
			return new Text(`${header}\n${theme.fg("toolOutput", shown.join("\n"))}${more}`, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!isEnabled()) throw new DeepSeekError("DeepSeek tools are off. Run /deepseek-tools on to enable them.");
			const started = Date.now();
			const page = await client.fetchPage(params.url, { signal });
			recordCall(ctx);
			const output = truncateHead(formatFetchedPage(page));
			let fullContentPath: string | null = null;
			let text = output.content;
			if (output.truncated) {
				fullContentPath = await writeFullPage(page);
				text += `\n\n[Truncated at ${describeLimit(output.truncatedBy)}, ${formatSize(output.totalBytes)} total. Full content written to ${fullContentPath}]`;
			}
			const details: FetchDetails = {
				url: page.url,
				title: page.title,
				bytes: output.totalBytes,
				truncated: output.truncated,
				durationMs: Date.now() - started,
			};
			return {
				content: [{ type: "text", text }],
				details,
				structuredContent: {
					url: page.url,
					title: page.title,
					content: output.content,
					truncated: output.truncated,
					fullContentPath,
				},
			};
		},
	});
}

function describeLimit(truncatedBy: "lines" | "bytes" | null): string {
	return truncatedBy === "lines" ? `${DEFAULT_MAX_LINES} lines` : formatSize(DEFAULT_MAX_BYTES);
}

function textOf(result: { content: Array<{ type: string }> }): string {
	const block = result.content.find((part) => part.type === "text") as { type: "text"; text: string } | undefined;
	return block?.text ?? "";
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? "failed";
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function writeFullPage(page: FetchedPage): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-fetch-"));
	const file = join(dir, "page.md");
	await writeFile(file, formatFetchedPage(page), "utf-8");
	return file;
}
