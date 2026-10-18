import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8192;
// Search returns one page per result, so cap each body to leave room for the others.
const MAX_RESULT_CONTENT_CHARS = 4_000;

export class DeepSeekError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "DeepSeekError";
		this.status = status;
	}
}

export type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	siteName: string | null;
	date: string | null;
	score: number | null;
	authority: number | null;
};

export type FetchedPage = {
	url: string;
	title: string;
	content: string;
};

export interface SearchOptions {
	query: string;
	count?: number;
	includeContent?: boolean;
	signal?: AbortSignal;
}

export interface DeepSeekClientOptions {
	apiKey?: string;
	baseUrl?: string;
}

export interface DeepSeekClient {
	search(options: SearchOptions): Promise<SearchResult[]>;
	fetchPage(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
}

export function createDeepSeekClient(options: DeepSeekClientOptions = {}): DeepSeekClient {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

	async function post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const apiKey = options.apiKey ?? resolveApiKey();
		for (let attempt = 1; ; attempt++) {
			const timeout = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			let response: Response;
			try {
				response = await globalThis.fetch(`${baseUrl}${path}`, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(body),
					signal: requestSignal,
				});
			} catch (error) {
				if (signal?.aborted) throw new DeepSeekError("Request cancelled");
				if (timeout.aborted) {
					if (attempt < MAX_ATTEMPTS) {
						await sleep(retryDelay(undefined, attempt), signal);
						continue;
					}
					throw new DeepSeekError(`POST ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
				}
				throw new DeepSeekError(`POST ${path} failed: ${errorMessage(error)}`);
			}
			if (response.ok) {
				const text = await response.text();
				try {
					return JSON.parse(text);
				} catch {
					throw new DeepSeekError(`POST ${path} returned invalid JSON: ${text.slice(0, 200)}`);
				}
			}
			const detail = await errorDetail(response);
			if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
				await sleep(retryDelay(response, attempt), signal);
				continue;
			}
			throw new DeepSeekError(`POST ${path} failed with HTTP ${response.status}: ${detail}`, response.status);
		}
	}

	async function search({ query, count = 5, includeContent = false, signal }: SearchOptions): Promise<SearchResult[]> {
		const normalized = query.trim();
		if (!normalized) throw new DeepSeekError("query must not be empty");
		const queryLength = [...normalized].length;
		if (queryLength > MAX_QUERY_CHARS) {
			throw new DeepSeekError(`query is ${queryLength} characters; the API accepts at most ${MAX_QUERY_CHARS}`);
		}
		const data = await post(
			"/v1/tools/search",
			{ query: normalized, count, need_content: includeContent },
			SEARCH_TIMEOUT_MS,
			signal,
		);
		const entries = isRecord(data) ? data.results : undefined;
		if (!Array.isArray(entries)) throw new DeepSeekError("search response is missing the results array");

		const results: SearchResult[] = [];
		for (const entry of entries) {
			if (!isRecord(entry)) continue;
			const url = asString(entry.url);
			if (!isHttpUrl(url)) continue;
			results.push({
				title: asString(entry.title) || url,
				url,
				snippet: asString(entry.snippet),
				summary: asString(entry.summary),
				content: asString(entry.content),
				siteName: asString(entry.site_name) || null,
				date: asString(entry.date) || null,
				score: asNumber(entry.rerank_score),
				authority: asNumber(entry.authority),
			});
		}
		if (entries.length > 0 && results.length === 0) {
			throw new DeepSeekError("search returned results without a usable http(s) URL");
		}
		return results;
	}

	async function fetchPage(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<FetchedPage> {
		const normalized = url.trim();
		assertFetchableUrl(normalized);
		let data: unknown;
		try {
			data = await post("/v1/tools/fetch", { url: normalized }, FETCH_TIMEOUT_MS, signal);
		} catch (error) {
			throw annotateFetchError(error);
		}
		if (!isRecord(data) || typeof data.content !== "string" || !data.content.trim()) {
			throw new DeepSeekError("fetch response is missing page content");
		}
		return { url: normalized, title: asString(data.title), content: data.content };
	}

	return { search, fetchPage };
}

export function formatSearchResults(results: SearchResult[], includeContent: boolean): string {
	if (results.length === 0) return "No results.";
	const blocks = results.map((result, index) => {
		const meta = [
			result.siteName && `site: ${result.siteName}`,
			result.date && `date: ${result.date.slice(0, 10)}`,
			result.score !== null && `score: ${result.score.toFixed(1)}`,
			result.authority !== null && result.authority >= 0 && `authority: ${result.authority}`,
		].filter(Boolean);
		const lines = [`${index + 1}. ${result.title}`, result.url];
		if (meta.length > 0) lines.push(meta.join(" · "));
		const summary = result.summary || result.snippet;
		if (summary) lines.push(summary);
		if (includeContent && result.content) {
			const content = result.content.length > MAX_RESULT_CONTENT_CHARS
				? `${result.content.slice(0, MAX_RESULT_CONTENT_CHARS)}\n[content truncated]`
				: result.content;
			lines.push("", content);
		}
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}

export function formatFetchedPage(page: FetchedPage): string {
	return page.title ? `# ${page.title}\n\n${page.content}` : page.content;
}

export function resolveApiKey(): string {
	const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const stored = readStoredCredential("deepseek");
	const storedKey = stored?.type === "api_key" ? stored.key?.trim() : undefined;
	if (storedKey) return storedKey;
	const configPath = webSearchConfigPath();
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			throw new DeepSeekError(`Cannot parse ${configPath}: ${errorMessage(error)}`);
		}
		const configured = isRecord(parsed) ? asString(parsed.deepseekApiKey) : "";
		if (configured) return configured;
	}
	throw new DeepSeekError(
		"DeepSeek API key not found. Run `pi auth` (or set DEEPSEEK_API_KEY, or add \"deepseekApiKey\" to " +
			`${configPath}). Get a key at https://platform.deepseek.com/api_keys`,
	);
}

// The same file and field pi-web-access reads, so one configured key serves both packages.
function webSearchConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) return join(agentDir, "web-search.json");
	const current = join(homedir(), ".pi", "agent", "web-search.json");
	if (existsSync(current)) return current;
	const legacy = join(homedir(), ".pi", "web-search.json");
	return existsSync(legacy) ? legacy : current;
}

// The API answers 404 when a page yields no Markdown and 403 when policy refuses it; say so, since the
// status alone reads like a wrong URL to the model.
function annotateFetchError(error: unknown): unknown {
	if (!(error instanceof DeepSeekError) || error.status === undefined) return error;
	if (error.status === 403) {
		return new DeepSeekError(`${error.message}. The site refused the fetch through DeepSeek's security policy.`, 403);
	}
	if (error.status === 404) {
		return new DeepSeekError(
			`${error.message}. DeepSeek got no usable page: the URL may be unavailable, blocked by the site, ` +
				"an unsupported content type, or without extractable text. Try another source.",
			404,
		);
	}
	return error;
}

function assertFetchableUrl(url: string): void {
	if (url.length === 0) throw new DeepSeekError("url must not be empty");
	if (url.length > MAX_URL_CHARS) {
		throw new DeepSeekError(`url is ${url.length} characters; the API accepts at most ${MAX_URL_CHARS}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new DeepSeekError(`url is not a valid absolute URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new DeepSeekError(`url must use http or https, got ${parsed.protocol}`);
	}
	if (!parsed.hostname) throw new DeepSeekError(`url must include a host: ${url}`);
	if (parsed.username || parsed.password) throw new DeepSeekError("url must not contain credentials");
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function errorDetail(response: Response): Promise<string> {
	const body = await response.text();
	try {
		const parsed = JSON.parse(body) as unknown;
		const message = isRecord(parsed) && isRecord(parsed.error) ? asString(parsed.error.message) : "";
		if (message) return message;
	} catch {
		// Fall back to the raw body below.
	}
	return body.trim().slice(0, 300) || response.statusText || "no response body";
}

function retryDelay(response: Response | undefined, attempt: number): number {
	const header = response?.headers.get("retry-after");
	const seconds = header ? Number(header) : Number.NaN;
	const delay = Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** (attempt - 1);
	return Math.min(Math.max(delay, 0), MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DeepSeekError("Request cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DeepSeekError("Request cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
