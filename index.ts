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
import { Type } from "typebox";
import { createDeepSeekClient, formatFetchedPage, formatSearchResults, type FetchedPage } from "./deepseek.ts";

const client = createDeepSeekClient();

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description:
			"Search the web with DeepSeek's search API and return ranked results (title, URL, long summary, site, date, quality score). " +
			"Query operators are passed through: site:example.com, -site:example.com, -word, -\"exact phrase\", \"exact phrase\", lang:zh,en, after:2025-01-01, before:2026-06-01. " +
			"Use deepseek_fetch to read one result in full.",
		parameters: Type.Object({
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
		}),
		outputSchema: searchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true },
		promptSnippet: "Search the web through DeepSeek Search",
		namespace: { name: "deepseek", description: "DeepSeek web search and page fetch APIs" },

		async execute(_toolCallId, params, signal) {
			const includeContent = params.includeContent ?? false;
			const results = await client.search({
				query: params.query,
				count: params.count,
				includeContent,
				signal,
			});
			const output = truncateHead(formatSearchResults(results, includeContent));
			const text = output.truncated
				? `${output.content}\n\n[Output truncated at ${describeLimit(output.truncatedBy)}. Fetch individual URLs with deepseek_fetch to read them.]`
				: output.content;
			return {
				content: [{ type: "text", text }],
				details: { query: params.query, count: results.length, includeContent },
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
		parameters: Type.Object({
			url: Type.String({ description: "HTTP(S) URL with a host, no credentials, at most 8192 characters" }),
		}),
		outputSchema: fetchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true },
		promptSnippet: "Fetch one URL as Markdown through DeepSeek Fetch",
		namespace: { name: "deepseek", description: "DeepSeek web search and page fetch APIs" },

		async execute(_toolCallId, params, signal) {
			const page = await client.fetchPage(params.url, { signal });
			const output = truncateHead(formatFetchedPage(page));
			let fullContentPath: string | null = null;
			let text = output.content;
			if (output.truncated) {
				fullContentPath = await writeFullPage(page);
				text += `\n\n[Truncated at ${describeLimit(output.truncatedBy)}, ${formatSize(output.totalBytes)} total. Full content written to ${fullContentPath}]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { url: page.url, title: page.title, bytes: output.totalBytes, truncated: output.truncated },
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

async function writeFullPage(page: FetchedPage): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-fetch-"));
	const file = join(dir, "page.md");
	await writeFile(file, formatFetchedPage(page), "utf-8");
	return file;
}
