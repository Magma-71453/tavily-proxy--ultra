# tavily-proxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Magma-71453/tavily-proxy--ultra)

A Cloudflare Worker that acts as an MCP (Model Context Protocol) proxy for the [Tavily API](https://tavily.com). It exposes the same tools as the official Tavily MCP server, but with an **API key pool** — automatically rotating through multiple Tavily keys and selecting the one with the most remaining credit.

## Features

- **MCP Server** — Streamable HTTP transport at `POST /mcp`, compatible with any MCP client
- **5 Tavily Tools** — search, extract, crawl, map, research (plus research status polling)
- **Full parameter coverage** — every parameter documented in the [Tavily API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search) is exposed, including publish-date filtering, language/country boosting, `include_favicon`, timeouts, `include_usage` and structured research output
- **API Key Pool** — Multiple Tavily API keys stored in Cloudflare KV; each request picks a random key that still has credit
- **Key Management API** — HTTP endpoints to add/delete keys and query their status
- **Auth Protected** — All endpoints (except health check) require an `x-api-key` header

## Endpoints

| Method   | Path        | Description                                      |
|----------|-------------|--------------------------------------------------|
| `POST`   | `/mcp`      | MCP Streamable HTTP endpoint (tool calls)        |
| `POST`   | `/api/keys` | Add a Tavily API key to the pool                 |
| `DELETE` | `/api/keys` | Remove a Tavily API key from the pool            |
| `GET`    | `/api/keys` | List all keys and their remaining credits        |
| `GET`    | `/`         | Health check (no auth required)                  |

All endpoints except `GET /` require the `x-api-key` header matching your configured `AUTH_KEY`.

## Tools

Each tool is registered under both the current official spelling and the legacy hyphenated one, so clients configured either way keep working:

| Current official name | Legacy alias      | Tavily endpoint           |
|-----------------------|-------------------|---------------------------|
| `tavily_search`       | `tavily-search`   | `POST /search`            |
| `tavily_extract`      | `tavily-extract`  | `POST /extract`           |
| `tavily_crawl`        | `tavily-crawl`    | `POST /crawl`             |
| `tavily_map`          | `tavily-map`      | `POST /map`               |
| `tavily_research`     | `tavily-research` | `POST /research`          |
| `tavily_research_get` | `tavily-research-get` | `GET /research/{id}`  |

### `tavily_search`

`query`, `search_depth` (`basic`/`advanced`/`fast`/`ultra-fast`), `topic` (`general`/`news`/`finance`), `max_results` (0-20), `time_range`, `start_date`, `end_date`, `include_published_date`, `filter_by_published_date`, `max_age_hours` (-1-720), `include_answer`, `include_raw_content`, `include_images`, `include_image_descriptions`, `include_favicon`, `include_domains`, `include_domains_mode` (`restrict`/`prefer`), `exclude_domains`, `country`, `language`, `filter_by_language`, `auto_parameters`, `exact_match`, `safe_search`, `chunks_per_source`, `include_usage`.

### `tavily_extract`

`urls`, `query`, `chunks_per_source`, `extract_depth`, `include_images`, `include_favicon`, `include_published_date`, `format`, `timeout` (1-60s), `include_usage`.

### `tavily_crawl`

`url`, `instructions`, `chunks_per_source`, `max_depth`, `max_breadth`, `limit`, `select_paths`, `select_domains`, `exclude_paths`, `exclude_domains`, `allow_external`, `include_images`, `extract_depth`, `format`, `include_favicon`, `timeout` (10-150s), `include_usage`.

### `tavily_map`

`url`, `instructions`, `max_depth`, `max_breadth`, `limit`, `select_paths`, `select_domains`, `exclude_paths`, `exclude_domains`, `allow_external`, `timeout` (10-150s), `include_usage`.

### `tavily_research` / `tavily_research_get`

`tavily_research` is asynchronous, mirroring the `POST /research` + `GET /research/{request_id}` API. It accepts `input`, `model` (`mini`/`pro`/`auto`), `citation_format`, `output_length`, `include_domains`, `exclude_domains`, `output_schema` (JSON Schema for a structured report) and `files` (up to 5 base64 attachments, `.txt`/`.md`/`.json`).

It returns the task's `request_id` immediately. Set `wait_seconds` (0-240, default 0) to poll server-side first, which returns the finished report inline when the task completes in time. `tavily_research_get` reports `pending`, `in_progress`, `completed` or `failed`, with the report in `content` and its sources in `sources`.

### Not proxied

`POST /feedback` and the enterprise `/logs` endpoint are not exposed. Everything else in the public API is.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account

### Local Development

```bash
# Install dependencies
npm install

# Set your auth key for local dev (copy .dev.vars.example to .dev.vars)
# AUTH_KEY=test-secret-key

# Typecheck
npm run build

# Start local server
npm run dev
```

Wrangler simulates KV locally — no Cloudflare account needed for development.

### One-Click Deploy

Click the **Deploy to Cloudflare** button above. Cloudflare will fork this repo into your GitHub account, automatically create the KV namespace, prompt you for the `AUTH_KEY` secret, and deploy the Worker. Then add your Tavily keys (see step 5 below).

### Deploy to Production (Manual)

1. **Create a KV namespace:**
   ```bash
   npx wrangler kv namespace create KV
   ```

2. **Update `wrangler.toml`** — replace `YOUR_KV_NAMESPACE_ID` with the real ID from step 1.

3. **Set the auth secret:**
   ```bash
   npx wrangler secret put AUTH_KEY
   ```

4. **Deploy:**
   ```bash
   npm run deploy
   ```

5. **Add Tavily API keys to the pool:**
   ```bash
   curl -X POST https://your-worker.workers.dev/api/keys \
     -H "Content-Type: application/json" \
     -H "x-api-key: your-auth-key" \
     -d '{"apiKey": "tvly-xxx"}'
   ```

## Usage

### Connect MCP Clients

With `mcp-remote` (for clients like Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-worker.workers.dev/mcp",
        "--header", "x-api-key:${AUTH_KEY}"
      ],
      "env": {
        "AUTH_KEY": "your-auth-key"
      }
    }
  }
}
```

### Key Management

```bash
# Add a key (auto-queries remaining credit from Tavily)
curl -X POST https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'

# List all keys and credits
curl https://your-worker.workers.dev/api/keys \
  -H "x-api-key: your-auth-key"

# Delete a key
curl -X DELETE https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'
```

## How the Key Pool Works

1. When a tool is called, `KV.list()` retrieves all stored API keys
2. A random key with remaining credit is selected
3. The request is proxied to `api.tavily.com` using that key
4. A 401/403 from Tavily invalidates that key and the call is retried on the next one
5. After the call, the credit cost is deducted locally in KV. When the response carries `usage.credits` (i.e. the caller passed `include_usage: true`) that exact value is used; otherwise the cost is estimated from the response size using Tavily's published pricing:

   | Endpoint | Credits |
   |----------|---------|
   | search `basic`/`fast`/`ultra-fast` | 1 per request |
   | search `advanced` | 2 per request |
   | extract | 1 per 5 successful URLs (2 for `advanced`) |
   | map | 1 per 10 pages returned (2 with `instructions`) |
   | crawl | map cost + extract cost |
   | research | dynamic: the request minimum is charged up front (4 for `mini`, 15 for `pro`/`auto`) |

6. When a key is added via `/api/keys`, its real remaining credit is fetched from Tavily's `/usage` endpoint
7. Every day at 00:00 Asia/Shanghai, all keys are refreshed from `/usage`, which also corrects any estimate drift; failed refreshes keep their cached values

## License

ISC
