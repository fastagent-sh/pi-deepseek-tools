<p align="center">
  <a href="https://fastagent.sh"><img src="https://cdn.jsdelivr.net/gh/fastagent-sh/pi-deepseek-web@main/assets/banner.png" alt="DeepSeek Web — search and page fetch as two Pi tools, by fastagent" width="860"></a>
</p>

[![CI](https://github.com/fastagent-sh/pi-deepseek-web/actions/workflows/ci.yml/badge.svg)](https://github.com/fastagent-sh/pi-deepseek-web/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@fastagent-sh/pi-deepseek-web.svg)](https://www.npmjs.com/package/@fastagent-sh/pi-deepseek-web)
[![downloads](https://img.shields.io/npm/dm/@fastagent-sh/pi-deepseek-web.svg)](https://www.npmjs.com/package/@fastagent-sh/pi-deepseek-web)
[![license](https://img.shields.io/npm/l/@fastagent-sh/pi-deepseek-web.svg)](https://github.com/fastagent-sh/pi-deepseek-web/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@fastagent-sh/pi-deepseek-web.svg)](https://nodejs.org)
[![built by fastagent](https://img.shields.io/badge/built%20by-fastagent-0b7285.svg)](https://fastagent.sh)
[![GitHub stars](https://img.shields.io/github/stars/fastagent-sh/pi-deepseek-web?style=social)](https://github.com/fastagent-sh/pi-deepseek-web/stargazers)
[![follow @kid7st](https://img.shields.io/badge/follow-%40kid7st-000?logo=x)](https://x.com/kid7st)

Two [Pi](https://pi.dev) tools for DeepSeek's [Search and Fetch APIs](https://api-docs.deepseek.com/zh-cn/guides/search/): ranked web results with model-ready summaries, and any page as Markdown. No model call is involved on either path.

```bash
pi install npm:@fastagent-sh/pi-deepseek-web
```

| Tool | Endpoint | Returns |
|---|---|---|
| `deepseek_search` | `POST /v1/tools/search` | Ranked results: title, URL, 600-800 character summary, site, date, `rerank_score` (0-3), `authority` (0-4), optional page text |
| `deepseek_fetch` | `POST /v1/tools/fetch` | One page as a title plus Markdown body |

## Why this package

- **It loads next to `pi-web-access`.** The tools are named `deepseek_search` and `deepseek_fetch`, so they do not replace or clash with `web_search` and `fetch_content`. Use DeepSeek for cheap research and the local extractors for the rest.
- **The ranking is in the result.** `rerank_score` and `authority` come back with every hit, and the summary is written for a model to read, so the agent can judge a source before fetching it.
- **No extra configuration.** The key is the DeepSeek credential pi already holds.

| | `pi-deepseek-web` | `pi-web-access` | `pi-web-search` |
|---|---|---|---|
| Tool names | `deepseek_search`, `deepseek_fetch` | `web_search`, `fetch_content` | `web_search`, `url_context` |
| Coexists with the other two | yes | — | yes |
| Providers | DeepSeek only | many search providers, local extraction | provider-native search |
| Model call needed | no | no | yes |

## API key

Resolved in this order:

1. `DEEPSEEK_API_KEY`
2. The `deepseek` credential from `pi auth` (`~/.pi/agent/auth.json`)
3. `deepseekApiKey` in `~/.pi/agent/web-search.json` (the field `pi-web-access` uses)

## Tools

### `deepseek_search`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | 1-128 characters. Operators pass through: `site:`, `-site:`, `-word`, `-"phrase"`, `"phrase"`, `lang:zh,en`, `after:2025-01-01`, `before:2026-06-01` |
| `count` | integer | 1-50, default 10 |
| `includeContent` | boolean | Also return extracted page text per result (default false). Costs context; prefer `deepseek_fetch` for one page |

```
deepseek_search {"query": "deepseek v4 release site:github.com OR site:huggingface.co lang:en after:2026-01-01", "count": 5}
```

### `deepseek_fetch`

| Parameter | Type | Notes |
|---|---|---|
| `url` | string, required | HTTP(S) URL with a host, no credentials, at most 8192 characters |

Text output is truncated at 50 KB / 2000 lines. A page that exceeds the limit is also written to a temp file and the result names its path. Both tools declare an `outputSchema`, so `codemode` scripts receive `structuredContent` instead of text.

## Behavior

- Retries HTTP 408, 429 and 5xx up to three attempts, honoring `Retry-After` and capping the delay at 5 s. Other 4xx errors fail immediately with the API message.
- Timeouts: 30 s for search, 60 s for fetch.
- Results without an `http(s)` URL are dropped; an empty `results` array is a normal "no results" answer.
- Failures surface as `POST /v1/tools/search failed with HTTP <status>: <message>`.

## Limits and cost

DeepSeek bills ¥5 per 1,000 successful requests (about $0.75) for each endpoint, and only successful requests with a result are charged. Each endpoint allows 5 QPS per account; the retry loop absorbs bursts from parallel tool calls. A `query` over 128 characters is rejected before the request is sent.

## Development

```bash
npm install
npm test        # node --test against a local mock server
npm run typecheck
npm audit --omit=dev
```

Publishing runs from a GitHub Release (`v1.0.0`) through Trusted Publishing with provenance; see [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## fastagent

This extension is one of the Pi packages published by [fastagent](https://fastagent.sh), the runtime that turns a local agent directory into a live service in your app, on Telegram, Slack or Feishu, or behind any channel.

- [fastagent.sh](https://fastagent.sh) — the product and docs
- [github.com/fastagent-sh](https://github.com/fastagent-sh) — every package, including [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) and [`@fastagent-sh/pi-web-access`](https://www.npmjs.com/package/@fastagent-sh/pi-web-access)
- [@kid7st](https://x.com/kid7st) — build notes and releases

## License

MIT
