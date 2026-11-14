import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { z } from "zod";
import * as tavilyClient from "./tavily-client.js";
import { pickBestKey, addKey, deleteKey, listKeys, deductCredit, invalidateKey, syncAllKeyUsage } from "./key-pool.js";

type Env = {
  KV: KVNamespace;
  AUTH_KEY: string;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const VERSION = "1.1.0";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth middleware: require x-api-key header on all routes except GET /
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  // Allow health check without auth
  if (c.req.path === "/" && c.req.method === "GET") {
    return next();
  }

  if (!c.env.AUTH_KEY) {
    return c.json({ error: "AUTH_KEY is not configured. Set it via `wrangler secret put AUTH_KEY` or Worker Settings > Variables and Secrets." }, 500);
  }

  const provided = c.req.header("x-api-key");
  if (!provided || provided !== c.env.AUTH_KEY) {
    return c.json({ error: "Unauthorized: invalid or missing x-api-key header" }, 401);
  }

  return next();
});

// ---------------------------------------------------------------------------
// Credit accounting
//
// Tavily bills per endpoint and per volume, so the exact price is only known
// after the call. Two sources are used, in order:
//   1. the response body's `usage.credits` (present when the caller passes
//      `include_usage: true`), which is exact;
//   2. a local estimate derived from the response size and parameters, per
//      https://docs.tavily.com/documentation/api-credits
// The daily cron (syncAllKeyUsage) reconciles both against the /usage endpoint.
// ---------------------------------------------------------------------------

function reportedCredits(result: unknown): number | null {
  const credits = (result as { usage?: { credits?: unknown } } | null)?.usage?.credits;
  return typeof credits === "number" && Number.isFinite(credits) ? credits : null;
}

function creditsFor(result: unknown, fallback: number): number {
  return reportedCredits(result) ?? fallback;
}

/** Number of pages/URLs Tavily actually processed, read from a response body. */
function processedPages(result: unknown): number {
  const results = (result as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results.length : 0;
}

/** Search: 1 credit, or 2 for `advanced`. */
function searchCost(depth: string | undefined): number {
  return depth === "advanced" ? 2 : 1;
}

/** Extract: 1 credit per 5 successful URLs, doubled for `advanced`. */
function extractCost(depth: string | undefined, pages: number): number {
  if (pages === 0) return 0;
  return Math.ceil(pages / 5) * (depth === "advanced" ? 2 : 1);
}

/** Map: 1 credit per 10 pages returned, doubled when `instructions` are used. */
function mapCost(instructions: string | undefined, pages: number): number {
  if (pages === 0) return 0;
  return Math.ceil(pages / 10) * (instructions ? 2 : 1);
}

/** Crawl: mapping cost + extraction cost over the pages returned. */
function crawlCost(instructions: string | undefined, depth: string | undefined, pages: number): number {
  if (pages === 0) return 0;
  return mapCost(instructions, pages) + extractCost(depth, pages);
}

/** Research is billed dynamically; charge the documented per-request minimum. */
function researchCost(model: string | undefined): number {
  return model === "mini" ? 4 : 15;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helper: call a Tavily endpoint with automatic key fallback on auth errors.
// If the selected key returns a 401/403, invalidate it and retry with the next
// key. Repeats until success or no keys remain.
// ---------------------------------------------------------------------------
type KeyedCall<T> = { ok: true; data: T } | { ok: false; result: ToolResult };

async function callWithKey<T>(
  kv: KVNamespace,
  toolName: string,
  fn: (apiKey: string) => Promise<T>,
  charge: (result: T) => number
): Promise<KeyedCall<T>> {
  const triedKeys = new Set<string>();

  while (true) {
    const apiKey = await pickBestKey(kv);
    if (!apiKey || triedKeys.has(apiKey)) {
      return {
        ok: false,
        result: {
          content: [{ type: "text", text: "Error: No available API keys in the pool. Please add keys first." }],
          isError: true,
        },
      };
    }
    triedKeys.add(apiKey);
    console.log(`[MCP] ${toolName} using key: ${apiKey.substring(0, 13)}...`);
    try {
      const data = await fn(apiKey);
      try {
        const credits = charge(data);
        if (credits > 0) {
          await deductCredit(kv, apiKey, credits);
        }
      } catch (err) {
        console.error(
          `[MCP] ${toolName} succeeded but failed to update cached credit for key ${apiKey.substring(0, 13)}...:`,
          err
        );
      }
      return { ok: true, data };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Invalidate key and retry on auth errors
      if (/Tavily API error (401|403)/.test(message)) {
        console.error(`[MCP] ${toolName} key ${apiKey.substring(0, 13)}... got auth error, invalidating and retrying`);
        await invalidateKey(kv, apiKey);
        continue;
      }
      return {
        ok: false,
        result: {
          content: [{ type: "text", text: `Error calling Tavily ${toolName}: ${message}` }],
          isError: true,
        },
      };
    }
  }
}

async function withKeyFallback<T>(
  kv: KVNamespace,
  toolName: string,
  fn: (apiKey: string) => Promise<T>,
  charge: (result: T) => number
): Promise<ToolResult> {
  const outcome = await callWithKey(kv, toolName, fn, charge);
  if (!outcome.ok) return outcome.result;
  return {
    content: [{ type: "text", text: JSON.stringify(outcome.data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Tool names.
//
// The current official Tavily MCP server registers `tavily_search`,
// `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research`; the
// official server used to use hyphens, and clients configured against this
// proxy already call `tavily-search` and friends. Every tool is therefore
// registered under both spellings so neither client breaks.
// ---------------------------------------------------------------------------
function toolNameVariants(name: string): string[] {
  return name.includes("_") ? [name, name.replace(/_/g, "-")] : [name, name.replace(/-/g, "_")];
}

// ---------------------------------------------------------------------------
// Helper: create a fresh MCP server with Tavily tools bound to a specific KV
// ---------------------------------------------------------------------------
function createMcpServer(kv: KVNamespace) {
  const server = new McpServer({
    name: "tavily-proxy",
    version: VERSION,
  });

  // -- search ---------------------------------------------------------------
  const searchSchema = z.object({
    query: z.string().describe("The search query to execute with Tavily."),
    search_depth: z
      .enum(["advanced", "basic", "fast", "ultra-fast"])
      .optional()
      .default("basic")
      .describe(
        "Controls the latency vs. relevance tradeoff. 'advanced': highest relevance, increased latency (2 credits). 'basic': balanced (1 credit). 'fast': lower latency, high relevance (1 credit). 'ultra-fast': minimum latency (1 credit)."
      ),
    topic: z
      .enum(["general", "news", "finance"])
      .optional()
      .default("general")
      .describe("The category of the search. 'news' for real-time updates, 'general' for broader searches, 'finance' for financial data."),
    max_results: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .default(5)
      .describe("The maximum number of search results to return (0-20). Tavily's own default is 10."),
    time_range: z
      .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
      .optional()
      .describe("Time range back from the current date, filtering on publish date. Not for live data (weather, prices, scores)."),
    start_date: z
      .string()
      .optional()
      .describe("Only return results published on or after this date, in YYYY-MM-DD format. Sources without a detectable date are kept unless filter_by_published_date is true."),
    end_date: z
      .string()
      .optional()
      .describe("Only return results published on or before this date, in YYYY-MM-DD format. Sources without a detectable date are kept unless filter_by_published_date is true."),
    include_published_date: z
      .boolean()
      .optional()
      .default(false)
      .describe("Add a 'published_date' field to each result (beta). Enabled automatically when topic is 'news'."),
    filter_by_published_date: z
      .boolean()
      .optional()
      .default(false)
      .describe("Remove results whose published date falls outside time_range/start_date/end_date, including results with no detectable date. Implies include_published_date."),
    max_age_hours: z
      .number()
      .int()
      .min(-1)
      .max(720)
      .optional()
      .describe("Max age in hours of Tavily's cached copy of each page. 0 = always fetch live, -1 = never fetch live, 1-720 = only cached copies fetched within that window. Unset lets Tavily decide."),
    include_answer: z
      .union([z.boolean(), z.enum(["basic", "advanced"])])
      .optional()
      .default(false)
      .describe("Include an LLM-generated answer. 'basic'/true for a quick answer, 'advanced' for a detailed one."),
    include_raw_content: z
      .union([z.boolean(), z.enum(["markdown", "text"])])
      .optional()
      .default(false)
      .describe("Include the cleaned page content of each result. 'markdown'/true for markdown, 'text' for plain text."),
    include_images: z
      .boolean()
      .optional()
      .default(false)
      .describe("Also perform an image search and include the results."),
    include_image_descriptions: z
      .boolean()
      .optional()
      .default(false)
      .describe("When include_images is true, also add a descriptive text for each image."),
    include_favicon: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include the favicon URL for each result."),
    include_domains: z
      .array(z.string())
      .optional()
      .describe("Domains to restrict results to (max 300), e.g. 'sec.gov'. Use full domains, not suffixes such as 'edu'."),
    include_domains_mode: z
      .enum(["restrict", "prefer"])
      .optional()
      .describe("How include_domains is applied: 'restrict' (default) keeps only those domains, 'prefer' also searches the rest of the web. Requires include_domains."),
    exclude_domains: z
      .array(z.string())
      .optional()
      .describe("Domains to exclude from results (max 150)."),
    country: z
      .string()
      .optional()
      .describe("Boost results from a specific country, given as a full lowercase country name ('united states', 'japan', 'germany'). ISO codes are not supported. Only for topic 'general'."),
    language: z
      .string()
      .optional()
      .describe("Boost results in a language, as an ISO 639-1 code ('en', 'fr', 'zh-cn') or an English name ('english', 'french'). Write the query in the same language for best results."),
    filter_by_language: z
      .boolean()
      .optional()
      .default(false)
      .describe("Strictly drop results that do not match 'language' instead of only boosting them. Requires 'language'."),
    auto_parameters: z
      .boolean()
      .optional()
      .default(false)
      .describe("Let Tavily tune search parameters from the query's intent. Explicitly passed parameters still win."),
    exact_match: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return results containing the exact quoted phrase(s) from the query, ignoring synonyms."),
    safe_search: z
      .boolean()
      .optional()
      .default(false)
      .describe("Filter out adult or unsafe content. Not supported for 'fast' or 'ultra-fast' search depths."),
    chunks_per_source: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe("Max relevant chunks per source (1-3). Only for 'advanced' search_depth."),
    include_usage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include Tavily credit usage for the request in the response."),
  });
  type SearchParams = z.infer<typeof searchSchema>;

  const searchHandler = async (params: SearchParams): Promise<ToolResult> => {
    const body: Record<string, unknown> = { ...params };
    // Tavily rejects include_domains_mode without include_domains, and
    // filter_by_language without language.
    if (!Array.isArray(body.include_domains) || body.include_domains.length === 0) {
      delete body.include_domains_mode;
    }
    if (!body.language) {
      delete body.filter_by_language;
    }
    return withKeyFallback(
      kv,
      "tavily_search",
      (apiKey) => tavilyClient.search(apiKey, body),
      (result) => creditsFor(result, searchCost(params.search_depth))
    );
  };

  for (const name of toolNameVariants("tavily_search")) {
    server.tool(
      name,
      "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with titles, URLs, and content snippets. Supports filtering by topic, publish date, language, country and domain, plus optional images and raw page content.",
      searchSchema.shape,
      searchHandler
    );
  }

  // -- extract --------------------------------------------------------------
  const extractSchema = z.object({
    urls: z
      .union([z.string(), z.array(z.string())])
      .describe("A single URL or a list of URLs to extract content from. Prefer URLs from search results; guessed page URLs often fail."),
    query: z
      .string()
      .optional()
      .describe("User intent used to rerank and keep only the relevant chunks of long pages. Leave empty for tables, lists and data files, which reranking can cut short."),
    extract_depth: z
      .enum(["basic", "advanced"])
      .optional()
      .default("basic")
      .describe("Depth of extraction. 'advanced' retrieves more data including tables (2 credits per 5 URLs vs 1 credit per 5 URLs)."),
    include_images: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include images found on the pages."),
    include_favicon: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include the favicon URL for each result."),
    include_published_date: z
      .boolean()
      .optional()
      .default(false)
      .describe("Add a 'published_date' field to each result (beta)."),
    format: z
      .enum(["markdown", "text"])
      .optional()
      .default("markdown")
      .describe("Format of the extracted content."),
    chunks_per_source: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Max relevant chunks per source (1-5). Only applied when 'query' is provided."),
    timeout: z
      .number()
      .min(1)
      .max(60)
      .optional()
      .describe("Extraction timeout in seconds (1-60). Defaults to 10s for basic and 30s for advanced extraction."),
    include_usage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include Tavily credit usage for the request in the response."),
  });
  type ExtractParams = z.infer<typeof extractSchema>;

  const extractHandler = async (params: ExtractParams): Promise<ToolResult> => {
    const body: Record<string, unknown> = { ...params };
    if (typeof body.urls === "string") {
      body.urls = [body.urls];
    }
    return withKeyFallback(
      kv,
      "tavily_extract",
      (apiKey) => tavilyClient.extract(apiKey, body),
      (result) => creditsFor(result, extractCost(params.extract_depth, processedPages(result)))
    );
  };

  for (const name of toolNameVariants("tavily_extract")) {
    server.tool(
      name,
      "Extract web page content from one or more specified URLs. Returns cleaned, parsed content optimized for LLMs. Supports basic and advanced extraction depths, optional image extraction, publish dates and content format selection.",
      extractSchema.shape,
      extractHandler
    );
  }

  // -- crawl ----------------------------------------------------------------
  const crawlSchema = z.object({
    url: z.string().describe("The root URL to begin the crawl."),
    instructions: z
      .string()
      .optional()
      .describe("Natural language instructions telling the crawler which kinds of pages to return. Doubles the mapping cost."),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(1)
      .describe("Max depth from the base URL the crawler can explore (1-5)."),
    max_breadth: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Max links to follow per page (1-500)."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(50)
      .describe("Total links the crawler will process before stopping."),
    select_paths: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to select only URLs with specific path patterns, e.g. '/docs/.*'."),
    select_domains: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to select specific domains or subdomains, e.g. '^docs\\.example\\.com$'."),
    exclude_paths: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to exclude URLs with specific path patterns."),
    exclude_domains: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to exclude specific domains or subdomains."),
    allow_external: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include external domain links in the results."),
    include_images: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to include images in the crawl results."),
    extract_depth: z
      .enum(["basic", "advanced"])
      .optional()
      .default("basic")
      .describe("Extraction depth. 'advanced' handles tables and embedded content, and costs more."),
    format: z
      .enum(["markdown", "text"])
      .optional()
      .default("markdown")
      .describe("Format of the extracted content."),
    include_favicon: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include the favicon URL for each result."),
    chunks_per_source: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Max relevant chunks per source (1-5). Only applied when 'instructions' is provided."),
    timeout: z
      .number()
      .min(10)
      .max(150)
      .optional()
      .describe("Crawl timeout in seconds (10-150). Defaults to 150."),
    include_usage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include Tavily credit usage for the request in the response."),
  });
  type CrawlParams = z.infer<typeof crawlSchema>;

  const crawlHandler = async (params: CrawlParams): Promise<ToolResult> => {
    return withKeyFallback(
      kv,
      "tavily_crawl",
      (apiKey) => tavilyClient.crawl(apiKey, { ...params }),
      (result) => creditsFor(result, crawlCost(params.instructions, params.extract_depth, processedPages(result)))
    );
  };

  for (const name of toolNameVariants("tavily_crawl")) {
    server.tool(
      name,
      "A graph-based website traversal tool that explores hundreds of paths in parallel with built-in extraction and intelligent discovery. Crawls from a base URL, extracts content, and returns structured results.",
      crawlSchema.shape,
      crawlHandler
    );
  }

  // -- map ------------------------------------------------------------------
  const mapSchema = z.object({
    url: z.string().describe("The root URL to begin the mapping."),
    instructions: z
      .string()
      .optional()
      .describe("Natural language instructions for the mapper. Doubles the cost."),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(1)
      .describe("Max depth from the base URL (1-5)."),
    max_breadth: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Max links to follow per page (1-500)."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(50)
      .describe("Total links to process before stopping."),
    select_paths: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to select only URLs with specific path patterns, e.g. '/docs/.*'."),
    select_domains: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to select specific domains or subdomains, e.g. '^docs\\.example\\.com$'."),
    exclude_paths: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to exclude URLs with specific path patterns."),
    exclude_domains: z
      .array(z.string())
      .optional()
      .describe("Regex patterns to exclude specific domains or subdomains."),
    allow_external: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include external domain links."),
    timeout: z
      .number()
      .min(10)
      .max(150)
      .optional()
      .describe("Map timeout in seconds (10-150). Defaults to 150."),
    include_usage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include Tavily credit usage for the request in the response."),
  });
  type MapParams = z.infer<typeof mapSchema>;

  const mapHandler = async (params: MapParams): Promise<ToolResult> => {
    return withKeyFallback(
      kv,
      "tavily_map",
      (apiKey) => tavilyClient.map(apiKey, { ...params }),
      (result) => creditsFor(result, mapCost(params.instructions, processedPages(result)))
    );
  };

  for (const name of toolNameVariants("tavily_map")) {
    server.tool(
      name,
      "Traverses websites like a graph to generate comprehensive site maps. Explores hundreds of paths in parallel with intelligent discovery. Returns a list of discovered URLs.",
      mapSchema.shape,
      mapHandler
    );
  }

  // -- research -------------------------------------------------------------
  // Tavily Research is asynchronous: POST /research creates a task, and
  // GET /research/{request_id} reports pending / in_progress / completed /
  // failed. `wait_seconds` polls server-side for a bounded window so short
  // tasks can return their report inline; 0 returns the task immediately.
  const researchSchema = z.object({
    input: z.string().describe("The research task or question to investigate."),
    model: z
      .enum(["mini", "pro", "auto"])
      .optional()
      .default("auto")
      .describe("Research depth. 'mini' for narrow, well-scoped questions (4-110 credits), 'pro' for broad multi-subtopic research (15-250 credits), 'auto' lets Tavily choose."),
    citation_format: z
      .enum(["numbered", "mla", "apa", "chicago"])
      .optional()
      .default("numbered")
      .describe("Citation style used in the report."),
    output_length: z
      .enum(["short", "standard", "long"])
      .optional()
      .default("standard")
      .describe("Target length of the report. These are targets, not hard caps."),
    include_domains: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Soft preference: domains the agent should prioritise (max 20). Other domains may still appear."),
    exclude_domains: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Hard blocklist: domains (and their subdomains) whose URLs must never appear (max 20)."),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema describing a structured report. Must contain a 'properties' field, and may contain 'required'. When set, the report is returned as an object."),
    files: z
      .array(z.object({ name: z.string(), content: z.string() }))
      .max(5)
      .optional()
      .describe("Up to 5 attachments used as sources alongside the web. Each entry is a filename plus base64-encoded contents; .txt, .md and .json only."),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(240)
      .optional()
      .default(0)
      .describe("How long to poll for the result before answering (0-240s). 0 returns the task id immediately; otherwise call tavily_research_get with the request_id."),
  });
  type ResearchParams = z.infer<typeof researchSchema>;

  const researchHandler = async (params: ResearchParams): Promise<ToolResult> => {
    const body: Record<string, unknown> = { ...params };
    const waitSeconds = Number(body.wait_seconds ?? 0);
    delete body.wait_seconds;

    const created = await callWithKey(
      kv,
      "tavily_research",
      (apiKey) => tavilyClient.research(apiKey, body),
      (result) => creditsFor(result, researchCost(params.model))
    );
    if (!created.ok) return created.result;

    const task = created.data as { request_id?: string; status?: string } | null;
    const requestId = task?.request_id;
    if (!requestId) {
      return { content: [{ type: "text", text: JSON.stringify(created.data, null, 2) }] };
    }

    let latest: unknown = created.data;
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 240) * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const polled = await callWithKey(
        kv,
        "tavily_research_get",
        (apiKey) => tavilyClient.getResearch(apiKey, requestId, false),
        () => 0
      );
      if (!polled.ok) return polled.result;
      latest = polled.data;
      const status = (latest as { status?: string } | null)?.status;
      if (status === "completed" || status === "failed") break;
    }

    return { content: [{ type: "text", text: JSON.stringify(latest, null, 2) }] };
  };

  for (const name of toolNameVariants("tavily_research")) {
    server.tool(
      name,
      "Run multi-source research on a question and return a cited report. Tavily plans, searches and reads sources; use it when the answer requires synthesis across many pages rather than a single lookup. Creates a research task and returns its request_id (plus the report if it finishes within wait_seconds); poll tavily_research_get for the rest. Rate limit: 20 requests per minute.",
      researchSchema.shape,
      researchHandler
    );
  }

  const researchGetSchema = z.object({
    request_id: z.string().describe("The request_id returned by tavily_research."),
    include_usage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include credit usage for the research task in the response."),
  });
  type ResearchGetParams = z.infer<typeof researchGetSchema>;

  const researchGetHandler = async (params: ResearchGetParams): Promise<ToolResult> => {
    return withKeyFallback(
      kv,
      "tavily_research_get",
      (apiKey) => tavilyClient.getResearch(apiKey, params.request_id, params.include_usage),
      () => 0
    );
  };

  for (const name of toolNameVariants("tavily_research_get")) {
    server.tool(
      name,
      "Fetch the status and result of a research task created by tavily_research. Status is 'pending', 'in_progress', 'completed' or 'failed'; a completed task returns the report in 'content' plus 'sources'.",
      researchGetSchema.shape,
      researchGetHandler
    );
  }

  return server;
}

const TOOL_NAMES = [
  ...toolNameVariants("tavily_search"),
  ...toolNameVariants("tavily_extract"),
  ...toolNameVariants("tavily_crawl"),
  ...toolNameVariants("tavily_map"),
  ...toolNameVariants("tavily_research"),
  ...toolNameVariants("tavily_research_get"),
];

// ---------------------------------------------------------------------------
// MCP endpoint - /mcp
// Matches the Tavily official MCP endpoint path
// ---------------------------------------------------------------------------
app.post("/mcp", async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  const server = createMcpServer(c.env.KV);

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await c.req.json());

    res.on("close", () => {
      transport.close();
      server.close();
    });

    return toFetchResponse(res);
  } catch (error) {
    console.error("MCP error:", error);
    return c.json({ error: "Internal MCP server error" }, 500);
  }
});

app.get("/mcp", async (c) => {
  return c.json({ error: "Method not allowed. MCP requires POST." }, 405);
});

app.delete("/mcp", async (c) => {
  return c.json({ error: "Method not allowed." }, 405);
});

// ---------------------------------------------------------------------------
// HTTP API: Key Management
// ---------------------------------------------------------------------------

// Add a key (queries Tavily for remaining credit, inserts/updates KV)
app.post("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    const info = await addKey(c.env.KV, body.apiKey);
    return c.json({ success: true, key: info });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Delete a key
app.delete("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    await deleteKey(c.env.KV, body.apiKey);
    return c.json({ success: true, deleted: body.apiKey });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// HTTP API: Query all keys status
// ---------------------------------------------------------------------------
app.get("/api/keys", async (c) => {
  try {
    const keys = await listKeys(c.env.KV);
    return c.json({ keys });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Health check / root
// ---------------------------------------------------------------------------
app.get("/", (c) => {
  return c.json({
    service: "tavily-proxy",
    version: VERSION,
    endpoints: {
      mcp: "POST /mcp",
      addKey: "POST /api/keys { apiKey: string }",
      deleteKey: "DELETE /api/keys { apiKey: string }",
      listKeys: "GET /api/keys",
    },
    tools: TOOL_NAMES,
  });
});

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAllKeyUsage(env.KV));
  },
} satisfies ExportedHandler<Env>;
