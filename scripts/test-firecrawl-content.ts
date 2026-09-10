/**
 * Firecrawl Content Completion diagnostic.
 *
 * This is intentionally independent of the Daily workflow and existing content
 * completion implementation: it only reads Raw Articles and writes local runtime artifacts.
 */
import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { resolveDailyScope } from "../src/lib/daily-scope.js";

const DEFAULT_LIMIT = 60;
const DEFAULT_PER_SOURCE_LIMIT = 3;
const DEFAULT_CONCURRENCY = 2;
const SHORT_CONTENT_CHARS = 500;
const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const REQUESTS_PER_WINDOW = 10;
const REQUEST_WINDOW_MS = 60_000;
// 已在 2026-09-09 Firecrawl diagnostic 中检查过；按数据库保存的原始 source 名匹配。
const CHECKED_SOURCE_NAMES = [
  "Nature",
  "Nature:  Biotechnology",
  "Nature: Chemistry",
  "ScienceDaily: Science",
  "YC Hacker News",
];

type Candidate = {
  id: string;
  source: string;
  title: string;
  url: string;
  originalContentLength: number;
};

type ArticleResult = {
  raw_article_id: string;
  source: string;
  title: string;
  url: string;
  original_content_length: number;
  firecrawl_success: boolean;
  firecrawl_content_length: number | null;
  duration_ms: number;
  error: string | null;
  markdown_file: string | null;
  has_abstract: boolean | null;
  has_paywall_marker: boolean | null;
};

type Summary = {
  daily_date: string;
  started_at: string;
  finished_at: string;
  limit: number;
  per_source_limit: number;
  concurrency: number;
  attempted: number;
  succeeded: number;
  failed: number;
  successRate: number;
  averageContentLength: number;
  averageDurationMs: number;
  sources: SourceSummary[];
};

type SourceSummary = {
  source: string;
  attempted: number;
  succeeded: number;
  failed: number;
  avg_content_length: number;
};

type FirecrawlResponse = {
  success?: boolean;
  markdown?: unknown;
  data?: { markdown?: unknown };
  error?: unknown;
};

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the Firecrawl diagnostic.");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is required for the Firecrawl diagnostic.");

  const scope = resolveDailyScope(options.date);
  const startedAt = new Date();
  const runDir = join(process.cwd(), "runtime", "firecrawl-content", toRunId(startedAt));
  const sourcesDir = join(runDir, "sources");
  await mkdir(sourcesDir, { recursive: true });

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const candidates = await loadCandidates(
      pool,
      scope.startAt,
      scope.endAt,
      options.perSourceLimit,
      options.limit,
    );
    console.log(JSON.stringify({
      daily_date: scope.dailyDate,
      sources: candidateCountsBySource(candidates),
    }, null, 2));
    const limiter = new FirecrawlRateLimiter();
    const results = await runWithConcurrency(candidates, options.concurrency, (candidate) =>
      scrapeCandidate(candidate, apiKey, sourcesDir, limiter),
    );
    const summary = summarize(scope.dailyDate, startedAt, options, results);
    await writeFile(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ ...summary, runtimeDir: runDir }, null, 2));
  } finally {
    await pool.end();
  }
}

async function loadCandidates(
  pool: Pool,
  startAt: string,
  endAt: string,
  perSourceLimit: number,
  limit: number,
): Promise<Candidate[]> {
  const result = await pool.query<Candidate>(
    `with ranked as (
       select ra.id, s.name as source, ra.title, ra.url,
              char_length(coalesce(ra.content_text, ''))::int as "originalContentLength",
              row_number() over (
                partition by s.id
                order by char_length(coalesce(ra.content_text, '')) asc,
                         ra.published_at desc nulls last,
                         ra.id asc
              ) as source_rank
         from raw_articles ra
         join sources s on s.id = ra.source_id
        where ra.url is not null
          and btrim(ra.url) <> ''
          and ra.published_at >= $1::timestamptz
          and ra.published_at < $2::timestamptz
          and (ra.content_text is null or char_length(btrim(ra.content_text)) < $3)
          and s.name <> all($4::text[])
     )
     select id, source, title, url, "originalContentLength"
       from ranked
      where source_rank <= $5
      order by source_rank asc, source asc, id asc
      limit $6`,
    [startAt, endAt, SHORT_CONTENT_CHARS, CHECKED_SOURCE_NAMES, perSourceLimit, limit],
  );
  return result.rows;
}

function candidateCountsBySource(candidates: Candidate[]): Array<{ source: string; candidates: number }> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.source, (counts.get(candidate.source) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, candidates]) => ({ source, candidates }));
}

async function scrapeCandidate(
  candidate: Candidate,
  apiKey: string,
  sourcesDir: string,
  limiter: FirecrawlRateLimiter,
): Promise<ArticleResult> {
  const startedAt = Date.now();
  try {
    while (true) {
      await limiter.beforeRequest();
      const response = await fetch(FIRECRAWL_SCRAPE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: candidate.url,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      });
      const body = await response.json().catch(() => null) as FirecrawlResponse | null;
      if (response.status === 429) {
        limiter.defer(retryDelayMs(response, body));
        continue;
      }

      const markdown = markdownFrom(body);
      if (!response.ok || body?.success === false || !markdown) {
        return failedResult(
          candidate,
          startedAt,
          errorFromResponse(response.status, body, markdown ? null : "Firecrawl returned no markdown."),
        );
      }

      const sourceDirectory = safeSourceName(candidate.source);
      const markdownFile = `sources/${sourceDirectory}/${candidate.id}.md`;
      await mkdir(join(sourcesDir, sourceDirectory), { recursive: true });
      await writeFile(join(sourcesDir, sourceDirectory, `${candidate.id}.md`), markdown);
      return {
        raw_article_id: candidate.id,
        source: candidate.source,
        title: candidate.title,
        url: candidate.url,
        original_content_length: candidate.originalContentLength,
        firecrawl_success: true,
        firecrawl_content_length: markdown.length,
        duration_ms: Date.now() - startedAt,
        error: null,
        markdown_file: markdownFile,
        has_abstract: /(^|\n)#{1,6}\s+abstract\b/im.test(markdown),
        has_paywall_marker: markdown.includes("This is a preview of subscription content"),
      };
    }
  } catch (error) {
    return failedResult(
      candidate,
      startedAt,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function markdownFrom(body: FirecrawlResponse | null): string | null {
  const value = body?.markdown ?? body?.data?.markdown;
  return typeof value === "string" && value.trim() ? value : null;
}

function errorFromResponse(
  status: number,
  body: FirecrawlResponse | null,
  fallback: string | null,
): string {
  const apiError = typeof body?.error === "string" ? body.error : null;
  return apiError ?? fallback ?? `Firecrawl HTTP ${status}`;
}

function failedResult(candidate: Candidate, startedAt: number, error: string): ArticleResult {
  return {
    raw_article_id: candidate.id,
    source: candidate.source,
    title: candidate.title,
    url: candidate.url,
    original_content_length: candidate.originalContentLength,
    firecrawl_success: false,
    firecrawl_content_length: null,
    duration_ms: Date.now() - startedAt,
    error,
    markdown_file: null,
    has_abstract: null,
    has_paywall_marker: null,
  };
}

function summarize(
  dailyDate: string,
  startedAt: Date,
  options: CliOptions,
  results: ArticleResult[],
): Summary {
  const succeeded = results.filter((result) => result.firecrawl_success);
  const totalDurationMs = results.reduce((sum, result) => sum + result.duration_ms, 0);
  const totalContentLength = succeeded.reduce(
    (sum, result) => sum + (result.firecrawl_content_length ?? 0),
    0,
  );
  return {
    daily_date: dailyDate,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    limit: options.limit,
    per_source_limit: options.perSourceLimit,
    concurrency: options.concurrency,
    attempted: results.length,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    successRate: results.length === 0 ? 0 : succeeded.length / results.length,
    averageContentLength: succeeded.length === 0 ? 0 : totalContentLength / succeeded.length,
    averageDurationMs: results.length === 0 ? 0 : totalDurationMs / results.length,
    sources: summarizeSources(results),
  };
}

function summarizeSources(results: ArticleResult[]): SourceSummary[] {
  const bySource = new Map<string, ArticleResult[]>();
  for (const result of results) {
    bySource.set(result.source, [...(bySource.get(result.source) ?? []), result]);
  }
  return [...bySource.entries()].map(([source, sourceResults]) => {
    const succeeded = sourceResults.filter((result) => result.firecrawl_success);
    return {
      source,
      attempted: sourceResults.length,
      succeeded: succeeded.length,
      failed: sourceResults.length - succeeded.length,
      avg_content_length: succeeded.length === 0
        ? 0
        : succeeded.reduce((sum, result) => sum + (result.firecrawl_content_length ?? 0), 0)
          / succeeded.length,
    };
  });
}

type CliOptions = { date: string; limit: number; perSourceLimit: number; concurrency: number };

function parseArguments(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !["date", "limit", "per-source", "concurrency"].includes(match[1] ?? "")) {
      throw new Error("Use --date=YYYY-MM-DD with optional --per-source=N, --limit=N and --concurrency=N.");
    }
    const [, key, value] = match;
    if (!key || !value || values.has(key)) throw new Error(`Invalid argument "${argument}".`);
    values.set(key, value);
  }
  const date = values.get("date");
  if (!date) throw new Error("--date=YYYY-MM-DD is required.");
  return {
    date,
    limit: positiveInteger(values.get("limit"), DEFAULT_LIMIT, "limit"),
    perSourceLimit: positiveInteger(values.get("per-source"), DEFAULT_PER_SOURCE_LIMIT, "per-source"),
    concurrency: positiveInteger(values.get("concurrency"), DEFAULT_CONCURRENCY, "concurrency"),
  };
}

function safeSourceName(source: string): string {
  const safe = source
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return safe || "unknown-source";
}

class FirecrawlRateLimiter {
  private requestsInWindow = 0;
  private nextAllowedAt = 0;
  private queue = Promise.resolve();

  async beforeRequest(): Promise<void> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.requestsInWindow >= REQUESTS_PER_WINDOW) {
        await wait(REQUEST_WINDOW_MS);
        this.requestsInWindow = 0;
      }
      const waitMs = this.nextAllowedAt - Date.now();
      if (waitMs > 0) await wait(waitMs);
      this.requestsInWindow += 1;
    } finally {
      release();
    }
  }

  defer(delayMs: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + delayMs);
  }
}

function retryDelayMs(response: Response, body: FirecrawlResponse | null): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  const reset = response.headers.get("x-ratelimit-reset") ?? response.headers.get("ratelimit-reset");
  if (reset) {
    const timestamp = Number(reset);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, (timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000) - Date.now());
    }
  }
  const error = typeof body?.error === "string" ? body.error : "";
  const retryMatch = /retry after\s+(\d+)\s*s/i.exec(error);
  if (retryMatch?.[1]) return Number(retryMatch[1]) * 1_000;
  const resetMatch = /resets at\s+(.+)$/i.exec(error);
  if (resetMatch?.[1]) {
    const timestamp = Date.parse(resetMatch[1]);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  return REQUEST_WINDOW_MS;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return numberValue;
}

async function runWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) results[index] = await task(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function toRunId(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

main().catch((error) => {
  console.error("Firecrawl content diagnostic failed.", error);
  process.exitCode = 1;
});
