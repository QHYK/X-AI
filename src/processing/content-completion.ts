/** Firecrawl-based Stage 1 input completion. No LLM is used here. 
    CPI / PPI / 非农 / BEA
    content_text       = 约 1k–2.5k 的 release opening
    full_content_text  = NULL
    content_type       = release_summary

    Nature paper
    content_text       = Abstract
    full_content_text  = NULL
    content_type       = abstract

    普通长文
    content_text       = <=4k Stage1 内容
    full_content_text  = cleaned 完整正文
    content_type       = article_body
*/
import type { Pool, PoolClient } from "pg";

export type ContentCompletionOptions = {
  limit?: number;
  perSourceLimit?: number;
  sourceNames?: string[];
  concurrency?: number;
  scopeStartAt?: string;
  scopeEndAt?: string;
};

export type CompletionStatus = "success" | "unusable" | "failed" | "skipped";
export type CompletionContentType =
  | "article_body"
  | "takeaways"
  | "key_points"
  | "abstract"
  | "description"
  | "summary"
  | "executive_summary"
  | "release_summary";

export type ContentCompletionResult = {
  rawArticleId: string;
  sourceName: string;
  title: string;
  url: string;
  status: CompletionStatus;
  contentType: CompletionContentType | null;
  originalLength: number;
  rawLength: number | null;
  contentLength: number | null;
  fullContentLength: number | null;
  requestCount: number;
  retryCount: number;
  error: string | null;
  rawMarkdown: string | null;
};

export type ContentCompletionSummary = {
  candidateCount: number;
  selectedCount: number;
  successCount: number;
  unusableCount: number;
  failedCount: number;
  skippedCount: number;
  remainingCount: number;
  limit: number;
  perSourceLimit: number;
  inputCount: number;
  attemptedCount: number;
  firecrawlRequestCount: number;
  retryCount: number;
  contentTypeDistribution: Partial<Record<CompletionContentType, number>>;
  rawLength: number;
  contentTextLength: number;
  fullContentTextLength: number;
  results: ContentCompletionResult[];
};

export type ContentCompletionMetrics = Pick<
  ContentCompletionSummary,
  | "candidateCount"
  | "selectedCount"
  | "successCount"
  | "unusableCount"
  | "failedCount"
  | "skippedCount"
  | "remainingCount"
  | "attemptedCount"
  | "firecrawlRequestCount"
  | "retryCount"
>;

export type ContentCompletionLimits = {
  limit: number;
  perSourceLimit: number;
};

type Candidate = {
  id: string;
  sourceName: string;
  title: string;
  url: string;
  contentText: string | null;
};

type FirecrawlBody = {
  success?: boolean;
  markdown?: unknown;
  data?: { markdown?: unknown };
  error?: unknown;
};

type FetchResult = {
  markdown: string | null;
  rawLength: number | null;
  requestCount: number;
  retryCount: number;
  error: string | null;
  requestSucceeded: boolean;
};

export type FirecrawlExtraction = {
  contentText: string | null;
  fullContentText: string | null;
  contentType: CompletionContentType | null;
};

const DEFAULT_LIMIT = Number(process.env.CONTENT_COMPLETION_LIMIT ?? 50);
const DEFAULT_PER_SOURCE_LIMIT = Number(
  process.env.CONTENT_COMPLETION_PER_SOURCE_LIMIT ?? 10,
);
const DEFAULT_CONCURRENCY = Number(
  process.env.CONTENT_COMPLETION_CONCURRENCY ?? 2,
);
// 是否值得触发 Content Completion 的正文长度阈值；不同于 Firecrawl 结果的最低可用阈值。
const SHORT_CONTENT_CHARS = Number(
  process.env.CONTENT_COMPLETION_SHORT_CHARS ?? 80,
);
const TIMEOUT_MS = Number(
  process.env.CONTENT_COMPLETION_FIRECRAWL_TIMEOUT_MS ?? 30_000,
);
const MAX_RETRIES = Number(
  process.env.CONTENT_COMPLETION_FIRECRAWL_MAX_RETRIES ?? 2,
);
const SPECIAL_SKIP_SOURCE_NAMES = new Set(["xkcd", "NASA Image of the Day"]);
const INSTITUTIONAL_RELEASE_SOURCE_NAMES = new Set([
  "CPI",
  "PPI",
  "非农报告 Employment Situation",
  "BEA - 商务部数据",
]);
const INSTITUTIONAL_SUMMARY_MAX_CHARS = 2_500;
// const PLACEHOLDERS = new Set(["comments", "comment", "read more", "continue reading...", "full text ]]>"]);

// Firecrawl 提取结果达到这一长度才有最低使用价值；并非决定是否进入补全的阈值。
const MIN_USEFUL_CHARS = 80;
// 供 Stage1 使用的 content_text 上限，避免单篇正文无限放大模型输入。达到此长度额外保留完整正文，供需要更长上下文的后续用途使用。
const STAGE1_MAX_CHARS = 4_000;

const ELIGIBILITY = `
  ra.stage1_status = 'pending'
  and ra.url is not null
  and (cardinality($1::text[]) = 0 or s.name = any($1::text[]))
  and length(btrim(coalesce(ra.content_text, ''))) < $2
  and ($3::timestamptz is null or ra.published_at >= $3::timestamptz)
  and ($4::timestamptz is null or ra.published_at < $4::timestamptz)
  and s.name not in ('xkcd', 'NASA Image of the Day')
`;

/** Content Completion 总入口：选取候选、受限并发补全，并汇总本次运行统计。 */
export async function completeRawArticleContent(
  pool: Pool,
  options: ContentCompletionOptions = {},
  onMetrics?: (metrics: Partial<ContentCompletionMetrics>) => void,
): Promise<ContentCompletionSummary> {
  const limits = resolveContentCompletionLimits(options);
  const candidateCount = await countCompletionCandidates(pool, options);
  onMetrics?.({ candidateCount });

  const candidates = await loadCompletionCandidates(pool, options);
  onMetrics?.({ selectedCount: candidates.length });

  const limiter = new FirecrawlRateLimiter();
  const results = await concurrent(
    candidates,
    Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    (candidate) => complete(pool, candidate, limiter),
  );
  const counts = summarizeCompletionResults(results);
  onMetrics?.(counts);

  const remainingCount = await countCompletionCandidates(pool, options);
  onMetrics?.({ remainingCount });

  return {
    candidateCount,
    selectedCount: candidates.length,
    remainingCount,
    ...limits,
    inputCount: candidates.length,
    attemptedCount: results.filter((result) => result.status !== "skipped").length,
    firecrawlRequestCount: sum(results, (result) => result.requestCount),
    retryCount: sum(results, (result) => result.retryCount),
    contentTypeDistribution: distribution(results),
    rawLength: sum(results, (result) => result.rawLength ?? 0),
    contentTextLength: sum(results, (result) => result.contentLength ?? 0),
    fullContentTextLength: sum(
      results,
      (result) => result.fullContentLength ?? 0,
    ),
    ...counts,
    results,
  };
}

export function resolveContentCompletionLimits(
  options: ContentCompletionOptions = {},
): ContentCompletionLimits {
  return {
    limit: options.limit ?? DEFAULT_LIMIT,
    perSourceLimit: options.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT,
  };
}

/** 单独统计完整候选池，用于区分实际处理量与受限后的待处理余量。 */
export async function countCompletionCandidates(
  queryable: Pick<Pool | PoolClient, "query">,
  options: ContentCompletionOptions = {},
): Promise<number> {
  const result = await queryable.query<{ count: number | string }>(
    `
      select count(*)::int as count
      from raw_articles ra
      join sources s on s.id = ra.source_id
      where ${ELIGIBILITY}
    `,
    values(options),
  );

  return Number(result.rows[0]?.count ?? 0);
}

/**
 * 按 source 排名再应用全局 limit，避免单一来源占满本次补全配额。
 */
export async function loadCompletionCandidates(
  queryable: Pick<Pool | PoolClient, "query">,
  options: ContentCompletionOptions,
): Promise<Candidate[]> {
  const limits = resolveContentCompletionLimits(options);
  const result = await queryable.query<Candidate>(
    `
      with ranked as (
        select
          ra.id,
          s.name as "sourceName",
          ra.title,
          ra.url,
          ra.content_text as "contentText",
          row_number() over (
            partition by s.id
            order by
              length(coalesce(ra.content_text, '')) asc,
              coalesce(ra.published_at, ra.collected_at) desc
          ) as source_rank
        from raw_articles ra
        join sources s on s.id = ra.source_id
        where ${ELIGIBILITY}
      )
      select id, "sourceName", title, url, "contentText"
      from ranked
      where source_rank <= $5
      order by source_rank asc, "sourceName" asc
      limit $6
    `,
    [...values(options), limits.perSourceLimit, limits.limit],
  );

  return result.rows;
}

// 解析选项并返回查询参数
function values(
  options: ContentCompletionOptions,
): [string[], number, string | null, string | null] {
  const sources = options.sourceNames?.filter(Boolean) ?? [];

  return [
    sources,
    SHORT_CONTENT_CHARS,
    options.scopeStartAt ?? null,
    options.scopeEndAt ?? null,
  ];
}

export function summarizeCompletionResults(
  results: ContentCompletionResult[],
): Pick<
  ContentCompletionSummary,
  "successCount" | "unusableCount" | "failedCount" | "skippedCount"
> {
  return {
    successCount: results.filter((result) => result.status === "success").length,
    unusableCount: results.filter((result) => result.status === "unusable")
      .length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
  };
}

/** 单篇处理链：Firecrawl 抓取、内容提取，并将结果及本次状态写回文章。 */
async function complete(
  pool: Pool,
  candidate: Candidate,
  limiter: FirecrawlRateLimiter,
): Promise<ContentCompletionResult> {
  const originalLength = candidate.contentText?.trim().length ?? 0;

  if (SPECIAL_SKIP_SOURCE_NAMES.has(candidate.sourceName)) {
    return makeResult(
      candidate,
      "skipped",
      null,
      originalLength,
      emptyFetch("special_source_skip"),
      null,
    );
  }

  const fetched = await scrape(candidate.url, limiter);

  if (!fetched.markdown) {
    const status = fetched.requestSucceeded ? "unusable" : "failed";
    await persist(
      pool,
      candidate.id,
      null,
      null,
      metadata(status, null, fetched, originalLength),
    );

    return makeResult(candidate, status, null, originalLength, fetched, null);
  }

  const extracted = extractFirecrawlContent(
    fetched.markdown,
    candidate.sourceName,
  );

  if (!extracted.contentText) {
    await persist(
      pool,
      candidate.id,
      null,
      null,
      metadata("unusable", null, fetched, originalLength),
    );

    return makeResult(candidate, "unusable", null, originalLength, fetched, null);
  }

  await persist(
    pool,
    candidate.id,
    extracted.contentText,
    extracted.fullContentText,
    metadata("success", extracted.contentType, fetched, originalLength, extracted),
  );

  return makeResult(
    candidate,
    "success",
    extracted.contentType,
    originalLength,
    fetched,
    extracted,
  );
}

/**
 * 只对可恢复的网络、5xx 与 429 重试；Firecrawl 已成功但内容无法提取时不再重复请求。
 */
async function scrape(
  url: string,
  limiter: FirecrawlRateLimiter,
): Promise<FetchResult> {
  let requests = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await limiter.beforeRequest();
    requests += 1;

    try {
      const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as FirecrawlBody | null;
      const markdown = markdownFrom(body);

      if (response.ok && body?.success !== false && markdown) {
        return {
          markdown,
          rawLength: markdown.length,
          requestCount: requests,
          retryCount: attempt,
          error: null,
          requestSucceeded: true,
        };
      }

      const error =
        typeof body?.error === "string"
          ? body.error
          : `Firecrawl HTTP ${response.status}`;

      if (response.ok && body?.success !== false) {
        return {
          markdown: null,
          rawLength: null,
          requestCount: requests,
          retryCount: attempt,
          error,
          requestSucceeded: true,
        };
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return {
          markdown: null,
          rawLength: null,
          requestCount: requests,
          retryCount: attempt,
          error,
          requestSucceeded: false,
        };
      }

      if (response.status === 429) {
        limiter.defer(retryMs(response, body));
      } else {
        await sleep(1_000 * (attempt + 1));
      }

      if (attempt === MAX_RETRIES) {
        return {
          markdown: null,
          rawLength: null,
          requestCount: requests,
          retryCount: attempt,
          error,
          requestSucceeded: false,
        };
      }
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        return {
          markdown: null,
          rawLength: null,
          requestCount: requests,
          retryCount: attempt,
          error: error instanceof Error ? error.message : String(error),
          requestSucceeded: false,
        };
      }

      await sleep(1_000 * (attempt + 1));
    }
  }

  return emptyFetch("Firecrawl retry exhausted.");
}

/**
 * 优先使用 Abstract、Takeaways、Key Points 等结构化片段，通常比通用正文更适合 Stage1 判断。
 */
export function extractFirecrawlContent(
  markdown: string,
  sourceName: string | null
): FirecrawlExtraction {
  // 1. 科研论文：只要 Abstract
  const abstract = section(markdown, ["abstract"]);
  if (useful(abstract)) {
    return extracted(clean(abstract), null, "abstract");
  }

  // 2. 页面原生的高信息密度结构
  const candidates: Array<[readonly string[], CompletionContentType]> = [
    [["ai takeaways", "takeaways"], "takeaways"],
    [["key points"], "key_points"],
    [["executive summary"], "executive_summary"],
    [["summary", "overview"], "summary"],
    [["description", "programme description"], "description"],
  ];

  for (const [headings, type] of candidates) {
    const value = section(markdown, headings);

    if (useful(value)) {
      return extracted(clean(value), null, type);
    }
  }

  // 3. 官方超长报告 release：只保留开头摘要，不保留完整正文
  if (
    sourceName &&
    INSTITUTIONAL_RELEASE_SOURCE_NAMES.has(sourceName)
  ) {
    const releaseSummary = extractInstitutionalReleaseSummary(markdown);

    if (useful(releaseSummary)) {
      return extracted(
        releaseSummary,
        null,
        "release_summary",
      );
    }
  }

  // 4. 普通文章
  const body = clean(markdown);

  if (!useful(body)) {
    return extracted(null, null, null);
  }

  return extracted(
    shorten(body),
    body.length > STAGE1_MAX_CHARS ? body : null,
    "article_body",
  );
}

/**
 * 提取 CPI、PPI、非农、BEA 等官方数据 release 的开头说明。
 *
 * 这类页面后半部分通常包含大量统计表、技术说明和附件，
 * 对 Stage1 判断事件没有必要，因此只保留正式 release 的开头正文。
 */
function extractInstitutionalReleaseSummary(markdown: string): string | null {
  const cleaned = clean(markdown);

  if (!cleaned) {
    return null;
  }

  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let meaningfulChars = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // 已经进入 Markdown 统计表，后续内容不再作为 Stage1 输入。
    if (
      meaningfulChars >= MIN_USEFUL_CHARS &&
      trimmed.startsWith("|")
    ) {
      break;
    }

    // 官方 release 常在正文后进入附件、完整表格或技术材料。
    if (
      meaningfulChars >= MIN_USEFUL_CHARS &&
      /^(#{1,6}\s*)?(full release|full release & tables|tables only|technical note|additional information|related materials)\b/i.test(
        trimmed,
      )
    ) {
      break;
    }

    kept.push(line);

    if (trimmed) {
      meaningfulChars += trimmed.length;
    }
  }

  const value = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!useful(value)) {
    return null;
  }

  return shortenInstitutionalSummary(value);
}

/**
 * 官方数据 release 只需要开头最重要的几段；
 * 优先在段落边界结束，而不是把整个 release 塞给 Stage1。
 */
function shortenInstitutionalSummary(value: string): string {
  if (value.length <= INSTITUTIONAL_SUMMARY_MAX_CHARS) {
    return value;
  }

  const boundary = value.lastIndexOf(
    "\n\n",
    INSTITUTIONAL_SUMMARY_MAX_CHARS,
  );

  return value
    .slice(
      0,
      boundary > MIN_USEFUL_CHARS
        ? boundary
        : INSTITUTIONAL_SUMMARY_MAX_CHARS,
    )
    .trim();
}

function section(markdown: string, headings: readonly string[]): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);

    return Boolean(
      match && headings.includes(match[1]?.trim().toLowerCase() ?? ""),
    );
  });

  if (index < 0) {
    return null;
  }

  const value: string[] = [];

  for (const line of lines.slice(index + 1)) {
    if (/^#{1,6}\s+/.test(line)) {
      break;
    }

    value.push(line);
  }

  return value.join("\n");
}

/** 这里只进行轻量 Markdown 清洗，去掉明显噪音，不承担完整正文 parser 的职责。 */
function clean(markdown: string): string {
  const kept: string[] = [];

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (
      /^(#{1,6}\s*)?(subscribe|sign in|access options|more from bloomberg|recommended|for you|top reads|related articles|newsletter|footer|copyright|privacy policy|terms of use|bloomberg terminal)\b/i.test(
        line.trim(),
      ) || /this is a preview of subscription content/i.test(line)
    ) {
      break;
    }

    if (!/^\s*(skip to main content|home|menu|search)\s*$/i.test(line)) {
      kept.push(line);
    }
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function useful(value: string | null): value is string {
  return Boolean(value && clean(value).length >= MIN_USEFUL_CHARS);
}

/** 将通用正文限制为 Stage1 所需长度，并尽量在段落边界截断。 */
function shorten(value: string): string {
  if (value.length <= STAGE1_MAX_CHARS) {
    return value;
  }

  const boundary = value.lastIndexOf("\n\n", STAGE1_MAX_CHARS);

  return value
    .slice(0, boundary > MIN_USEFUL_CHARS ? boundary : STAGE1_MAX_CHARS)
    .trim();
}

function extracted(
  contentText: string | null,
  fullContentText: string | null,
  contentType: CompletionContentType | null,
): FirecrawlExtraction {
  return {
    contentText,
    fullContentText,
    contentType,
  };
}

/** 将 Stage1 输入、可复用全文与本次补全元数据分别写入各自字段。 */
async function persist(
  pool: Pool,
  id: string,
  content: string | null,
  full: string | null,
  completion: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `
      update raw_articles
      set
        content_text = coalesce($1::text, content_text),
        full_content_text = $2::text,
        metadata = coalesce(metadata, '{}'::jsonb)
          || jsonb_build_object('content_completion', $3::jsonb)
      where id = $4
    `,
    [content, full, JSON.stringify(completion), id],
  );
}

function metadata(
  status: "success" | "unusable" | "failed",
  type: CompletionContentType | null,
  fetched: FetchResult,
  original: number,
  extraction?: FirecrawlExtraction,
): Record<string, unknown> {
  return {
    provider: "firecrawl",
    status,
    content_type: type,
    attempted_at: new Date().toISOString(),
    rss_original_length: original,
    raw_length: fetched.rawLength ?? 0,
    content_length: extraction?.contentText?.length ?? 0,
    full_content_length: extraction?.fullContentText?.length ?? 0,
    request_count: fetched.requestCount,
    retry_count: fetched.retryCount,
    error: fetched.error,
  };
}

function makeResult(
  candidate: Candidate,
  status: CompletionStatus,
  type: CompletionContentType | null,
  original: number,
  fetched: FetchResult,
  extraction: FirecrawlExtraction | null,
): ContentCompletionResult {
  return {
    rawArticleId: candidate.id,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    status,
    contentType: type,
    originalLength: original,
    rawLength: fetched.rawLength,
    contentLength: extraction?.contentText?.length ?? null,
    fullContentLength: extraction?.fullContentText?.length ?? null,
    requestCount: fetched.requestCount,
    retryCount: fetched.retryCount,
    error: status === "unusable" ? null : fetched.error,
    rawMarkdown: fetched.markdown,
  };
}

function emptyFetch(error: string): FetchResult {
  return {
    markdown: null,
    rawLength: null,
    requestCount: 0,
    retryCount: 0,
    error,
    requestSucceeded: false,
  };
}

function markdownFrom(body: FirecrawlBody | null): string | null {
  const value = body?.markdown ?? body?.data?.markdown;

  return typeof value === "string" && value.trim() ? value : null;
}

function apiKey(): string {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is required for Content Completion.");
  }

  return process.env.FIRECRAWL_API_KEY;
}

function sum<T>(values: T[], mapper: (value: T) => number): number {
  return values.reduce((total, value) => total + mapper(value), 0);
}

function distribution(
  results: ContentCompletionResult[],
): Partial<Record<CompletionContentType, number>> {
  const result: Partial<Record<CompletionContentType, number>> = {};

  for (const item of results) {
    if (item.contentType) {
      result[item.contentType] = (result[item.contentType] ?? 0) + 1;
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将并发 worker 的请求节奏串行化，避免超过 Free Plan 每分钟 10 次请求的限制。 */
class FirecrawlRateLimiter {
  private count = 0;
  private nextAllowedAt = 0;
  private queue = Promise.resolve();

  async beforeRequest(): Promise<void> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (this.count >= 10) {
        await sleep(60_000);
        this.count = 0;
      }

      const delay = this.nextAllowedAt - Date.now();

      if (delay > 0) {
        await sleep(delay);
      }

      this.count += 1;
    } finally {
      release();
    }
  }

  defer(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms);
  }
}

function retryMs(response: Response, body: FirecrawlBody | null): number {
  const header = response.headers.get("retry-after");

  if (header && Number.isFinite(Number(header))) {
    return Number(header) * 1_000;
  }

  const error = typeof body?.error === "string" ? body.error : "";
  const match = /retry after\s+(\d+)\s*s/i.exec(error);

  return match?.[1] ? Number(match[1]) * 1_000 : 60_000;
}

/** 以固定数量 worker 拉取队列，保留输入顺序并让每个 worker 处理下一项。 */
async function concurrent<T, R>(
  items: T[],
  count: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        const item = items[current];

        if (item !== undefined) {
          results[current] = await task(item);
        }
      }
    }),
  );

  return results;
}
