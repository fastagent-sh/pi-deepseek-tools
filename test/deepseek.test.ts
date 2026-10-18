import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createDeepSeekClient,
	DeepSeekError,
	formatFetchedPage,
	formatSearchResults,
	resolveApiKey,
	type SearchResult,
} from "../deepseek.ts";

interface RecordedRequest {
	path: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
}

type Handler = (request: RecordedRequest, response: ServerResponse, count: number) => void;

async function withServer(handler: Handler, run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>) {
	const requests: RecordedRequest[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			const entry: RecordedRequest = {
				path: request.url ?? "",
				authorization: request.headers.authorization,
				body: raw ? JSON.parse(raw) : {},
			};
			requests.push(entry);
			handler(entry, response, requests.length);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	try {
		await run(`http://127.0.0.1:${port}`, requests);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function reply(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

const sampleResult = {
	rerank_score: 2.4,
	title: "DeepSeek V4",
	url: "https://example.com/deepseek-v4",
	snippet: "short",
	summary: "long summary",
	content: "page body",
	site_name: "Example",
	date: "2026-06-01T00:00:00+00:00",
	authority: 3,
};

test("search sends the documented body and maps results", async () => {
	await withServer(
		(_request, response) => reply(response, 200, { results: [sampleResult, { url: "ftp://example.com/x" }, { ...sampleResult, url: "https://example.com/two" }] }),
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			const results = await client.search({ query: "deepseek v4", count: 5, includeContent: true });

			assert.deepEqual(requests[0].body, { query: "deepseek v4", count: 5, need_content: true });
			assert.equal(requests[0].path, "/v1/tools/search");
			assert.equal(requests[0].authorization, "Bearer test-key");
			assert.equal(results.length, 2);
			assert.deepEqual(results[0], {
				title: "DeepSeek V4",
				url: "https://example.com/deepseek-v4",
				snippet: "short",
				summary: "long summary",
				content: "page body",
				siteName: "Example",
				date: "2026-06-01T00:00:00+00:00",
				score: 2.4,
				authority: 3,
			});
		},
	);
});

test("search defaults to five results without page content", async () => {
	await withServer(
		(_request, response) => reply(response, 200, { results: [] }),
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			await client.search({ query: "q" });
			assert.deepEqual(requests[0].body, { query: "q", count: 5, need_content: false });
		},
	);
});

test("search rejects a query the API would reject", async () => {
	await withServer(
		(_request, response) => reply(response, 200, { results: [] }),
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			await assert.rejects(client.search({ query: "x".repeat(129) }), /at most 128/);
			assert.equal(requests.length, 0);
		},
	);
});

test("search treats results without usable URLs as a broken response", async () => {
	await withServer(
		(_request, response) => reply(response, 200, { results: [{ url: "javascript:alert(1)" }] }),
		async (baseUrl) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			await assert.rejects(client.search({ query: "q" }), /without a usable http\(s\) URL/);
		},
	);
});

test("search retries a rate-limited request", async () => {
	await withServer(
		(_request, response, count) => {
			if (count === 1) {
				reply(response, 429, { error: { message: "too many requests" } }, { "retry-after": "0" });
				return;
			}
			reply(response, 200, { results: [sampleResult] });
		},
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			const results = await client.search({ query: "q" });
			assert.equal(results.length, 1);
			assert.equal(requests.length, 2);
		},
	);
});

test("search does not retry a rejected request", async () => {
	await withServer(
		(_request, response) => reply(response, 400, { error: { message: "'count' must be between 1 and 50" } }),
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			await assert.rejects(client.search({ query: "q" }), (error: unknown) => {
				assert.ok(error instanceof DeepSeekError);
				assert.equal(error.status, 400);
				assert.match(error.message, /HTTP 400: 'count' must be between 1 and 50/);
				return true;
			});
			assert.equal(requests.length, 1);
		},
	);
});

test("fetchPage returns the page title and markdown body", async () => {
	await withServer(
		(_request, response) => reply(response, 200, { title: "Example article", content: "# Example article\n\nBody." }),
		async (baseUrl, requests) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			const page = await client.fetchPage("https://example.com/article");

			assert.deepEqual(requests[0].body, { url: "https://example.com/article" });
			assert.equal(requests[0].path, "/v1/tools/fetch");
			assert.deepEqual(page, {
				url: "https://example.com/article",
				title: "Example article",
				content: "# Example article\n\nBody.",
			});
		},
	);
});

test("fetchPage rejects URLs the API refuses", async () => {
	const client = createDeepSeekClient({ apiKey: "test-key", baseUrl: "http://127.0.0.1:1" });
	await assert.rejects(client.fetchPage("file:///etc/passwd"), /must use http or https/);
	await assert.rejects(client.fetchPage("https://user:secret@example.com/"), /must not contain credentials/);
	await assert.rejects(client.fetchPage("not a url"), /not a valid absolute URL/);
});

test("fetchPage explains a page DeepSeek could not read", async () => {
	await withServer(
		(_request, response) => reply(response, 404, { error: { message: "failed to fetch URL" } }),
		async (baseUrl) => {
			const client = createDeepSeekClient({ apiKey: "test-key", baseUrl });
			await assert.rejects(client.fetchPage("https://example.com/x"), (error: unknown) => {
				assert.ok(error instanceof DeepSeekError);
				assert.equal(error.status, 404);
				assert.match(error.message, /failed to fetch URL\. DeepSeek got no usable page/);
				return true;
			});
		},
	);
});

test("resolveApiKey prefers the environment, then the shared config file", () => {
	const saved = {
		home: process.env.HOME,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		key: process.env.DEEPSEEK_API_KEY,
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-deepseek-key-"));
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		delete process.env.DEEPSEEK_API_KEY;
		assert.throws(() => resolveApiKey(), /DeepSeek API key not found/);
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ deepseekApiKey: "sk-from-config" }));
		assert.equal(resolveApiKey(), "sk-from-config");
		process.env.DEEPSEEK_API_KEY = "sk-from-env";
		assert.equal(resolveApiKey(), "sk-from-env");
	} finally {
		process.env.HOME = saved.home;
		if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
		if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = saved.key;
	}
});

test("formatSearchResults includes page bodies only when asked", () => {
	const results: SearchResult[] = [
		{
			title: "Title",
			url: "https://example.com/page",
			snippet: "short",
			summary: "long summary",
			content: "page body",
			siteName: "Example",
			date: "2026-06-01T00:00:00+00:00",
			score: 2.4,
			authority: 3,
		},
	];

	const withoutContent = formatSearchResults(results, false);
	assert.match(withoutContent, /^1\. Title\nhttps:\/\/example\.com\/page\n/);
	assert.match(withoutContent, /site: Example · date: 2026-06-01 · score: 2\.4 · authority: 3/);
	assert.match(withoutContent, /long summary/);
	assert.doesNotMatch(withoutContent, /page body/);

	assert.match(formatSearchResults(results, true), /page body/);
	assert.equal(formatSearchResults([], false), "No results.");
	assert.equal(formatFetchedPage({ url: "u", title: "T", content: "C" }), "# T\n\nC");
});
