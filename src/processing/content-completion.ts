import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { Pool, PoolClient } from "pg";

export type ContentCompletionOptions = {
  limit?: number;
  perSourceLimit?: number;
  sourceNames?: string[];
  concurrency?: number;
};

export type ContentCompletionResult = {
  rawArticleId: string;
  sourceName: string;
  title: string;
  url: string;
  status: "updated" | "failed" | "skipped";
  trigger: CompletionTrigger | null;
  skipReason: string | null;
  originalLength: number;
  extractedLength: number | null;
  httpStatus: number | null;
  error: string | null;
};

export type ContentCompletionSummary = {
  candidateCount: number;
  selectedCount: number;
  successCount: number;
  remainingCount: number;
  limit: number;
  perSourceLimit: number;
  checkedCount: number;
  attemptedCount: number;
  updatedCount: number;
  failedCount: number;
  skippedCount: number;
  results: ContentCompletionResult[];
};

export type ContentCompletionMetrics = Pick<
  ContentCompletionSummary,
  | "candidateCount"
  | "selectedCount"
  | "successCount"
  | "failedCount"
  | "skippedCount"
  | "remainingCount"
>;

export type ContentCompletionLimits = {
  limit: number;
  perSourceLimit: number;
};

type CompletionTrigger = "empty_content" | "invalid_placeholder" | "short_long_form";

type RawArticleCompletionCandidate = {
  id: string;
  sourceName: string;
  sourceCategory: string;
  sourceType: string | null;
  title: string;
  url: string;
  contentText: string | null;
};

type ExtractionResult = {
  httpStatus: number | null;
  finalUrl: string;
  htmlFetched: boolean;
  text: string;
  error: string | null;
};

const DEFAULT_LIMIT = Number(process.env.CONTENT_COMPLETION_LIMIT ?? 50);
const DEFAULT_PER_SOURCE_LIMIT = Number(process.env.CONTENT_COMPLETION_PER_SOURCE_LIMIT ?? 10);
const DEFAULT_CONCURRENCY = Number(process.env.CONTENT_COMPLETION_CONCURRENCY ?? 4);
const FETCH_TIMEOUT_MS = Number(process.env.CONTENT_COMPLETION_FETCH_TIMEOUT_MS ?? 20_000);
const DOMAIN_DELAY_MS = Number(process.env.CONTENT_COMPLETION_DOMAIN_DELAY_MS ?? 3_000);
const LONG_FORM_SHORT_CONTENT_CHARS = Number(
  process.env.CONTENT_COMPLETION_LONG_FORM_SHORT_CHARS ?? 500,
);
const MIN_EXTRACTED_TEXT_CHARS = Number(process.env.CONTENT_COMPLETION_MIN_TEXT_CHARS ?? 700);
const MIN_IMPROVEMENT_CHARS = Number(process.env.CONTENT_COMPLETION_MIN_IMPROVEMENT_CHARS ?? 500);

const PLACEHOLDER_CONTENT = new Set(["comments", "comment", "read more"]);

const SPECIAL_SKIP_SOURCE_NAMES = new Set(["xkcd", "NASA Image of the Day"]);

const KNOWN_BLOCKED_SOURCE_NAMES = new Set([
  "Nature: Chemistry",
  "Nature:  Biotechnology",
  "Bloomberg Opinion",
  "FT Lex Best",
  "The Economist: Business",
  "The Economist: China",
  "The Economist: Finance and economics",
  "The Economist: Financial Indicators",
  "The Economist: International",
  "The Economist: Science and technology",
]);

const CHALLENGE_MARKERS = [
  "are you a robot",
  "client challenge",
  "security verification",
  "access denied",
  "captcha",
  "unusual activity",
  "enable javascript and cookies",
  "cloudflare",
];

const COMPLETION_ELIGIBILITY_SQL = `
  ra.stage1_status = 'pending'
  and ra.url is not null
  and (
    cardinality($1::text[]) = 0
    or s.name = any($1::text[])
  )
  and (
    $4::boolean = true
    or ra.content_text is null
    or btrim(ra.content_text) = ''
    or lower(btrim(ra.content_text)) = any($2::text[])
    or (
      s.category = 'long-form'
      and length(ra.content_text) < $3
    )
  )
`;

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
  const completedResults: ContentCompletionResult[] = [];
  const results = await runWithConcurrency(
    candidates,
    Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    async (candidate) => {
      const result = await completeRawArticle(pool, candidate);
      completedResults.push(result);
      onMetrics?.(summarizeCompletionResults(completedResults));
      return result;
    },
  );
  const resultCounts = summarizeCompletionResults(results);
  onMetrics?.(resultCounts);
  const remainingCount = await countCompletionCandidates(pool, options);
  onMetrics?.({ remainingCount });

  return {
    candidateCount,
    selectedCount: candidates.length,
    successCount: resultCounts.successCount,
    remainingCount,
    ...limits,
    checkedCount: results.length,
    attemptedCount: results.filter((result) => result.status !== "skipped").length,
    updatedCount: resultCounts.successCount,
    failedCount: resultCounts.failedCount,
    skippedCount: resultCounts.skippedCount,
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

export async function countCompletionCandidates(
  queryable: Pick<Pool | PoolClient, "query">,
  options: ContentCompletionOptions = {},
): Promise<number> {
  const result = await queryable.query<{ count: number | string }>(
    `
      select count(*)::int as count
      from raw_articles ra
      join sources s on s.id = ra.source_id
      where ${COMPLETION_ELIGIBILITY_SQL}
    `,
    completionEligibilityValues(options),
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function loadCompletionCandidates(
  queryable: Pick<Pool | PoolClient, "query">,
  options: ContentCompletionOptions,
): Promise<RawArticleCompletionCandidate[]> {
  const limits = resolveContentCompletionLimits(options);
  const result = await queryable.query<RawArticleCompletionCandidate>(
    `
      with ranked as (
        select
          ra.id,
          s.name as "sourceName",
          s.category as "sourceCategory",
          s.source_type as "sourceType",
          ra.title,
          ra.url,
          ra.content_text as "contentText",
          row_number() over (
            partition by s.id
            order by
              case
                when ra.content_text is null or btrim(ra.content_text) = '' then 0
                when lower(btrim(ra.content_text)) = any($2::text[]) then 1
                when s.category = 'long-form'
                  and length(ra.content_text) < $3 then 2
                else 3
              end,
              length(coalesce(ra.content_text, '')) asc,
              coalesce(ra.published_at, ra.collected_at) desc
          ) as source_rank
        from raw_articles ra
        join sources s on s.id = ra.source_id
        where ${COMPLETION_ELIGIBILITY_SQL}
      )
      select
        id,
        "sourceName",
        "sourceCategory",
        "sourceType",
        title,
        url,
        "contentText"
      from ranked
      where source_rank <= $5
      order by "sourceName", source_rank
      limit $6
    `,
    [
      ...completionEligibilityValues(options),
      limits.perSourceLimit,
      limits.limit,
    ],
  );

  return result.rows;
}

export function summarizeCompletionResults(
  results: ContentCompletionResult[],
): Pick<ContentCompletionMetrics, "successCount" | "failedCount" | "skippedCount"> {
  return {
    successCount: results.filter((result) => result.status === "updated").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
  };
}

function completionEligibilityValues(
  options: ContentCompletionOptions,
): [string[], string[], number, boolean] {
  const sourceNames = options.sourceNames?.filter(Boolean) ?? [];
  return [
    sourceNames,
    [...PLACEHOLDER_CONTENT],
    LONG_FORM_SHORT_CONTENT_CHARS,
    sourceNames.length > 0,
  ];
}

async function completeRawArticle(
  pool: Pool,
  candidate: RawArticleCompletionCandidate,
): Promise<ContentCompletionResult> {
  const originalLength = normalizedLength(candidate.contentText);
  const trigger = getCompletionTrigger(candidate);

  if (SPECIAL_SKIP_SOURCE_NAMES.has(candidate.sourceName)) {
    return skippedResult(candidate, trigger, originalLength, "special_source_skip");
  }

  if (KNOWN_BLOCKED_SOURCE_NAMES.has(candidate.sourceName)) {
    return skippedResult(candidate, trigger, originalLength, "known_blocked_source");
  }

  if (!trigger) {
    return skippedResult(candidate, null, originalLength, "trigger_not_met");
  }

  const extraction = await extractReadableText(candidate.url);
  if (extraction.error) {
    return failedResult(candidate, trigger, originalLength, extraction, extraction.error);
  }

  if (!extraction.htmlFetched || !isSuccessfulStatus(extraction.httpStatus)) {
    return failedResult(
      candidate,
      trigger,
      originalLength,
      extraction,
      extraction.httpStatus ? `HTTP ${extraction.httpStatus}` : "HTML fetch failed",
    );
  }

  if (isBlockedOrChallengeText(extraction.text)) {
    return failedResult(candidate, trigger, originalLength, extraction, "blocked_or_challenge_page");
  }

  if (!isMeaningfulImprovement(candidate.contentText, extraction.text)) {
    return failedResult(
      candidate,
      trigger,
      originalLength,
      extraction,
      "extracted_text_not_better_than_existing_content",
    );
  }

  const client = await pool.connect();
  try {
    await updateRawArticleContent(client, candidate.id, extraction.text);
  } finally {
    client.release();
  }

  return {
    rawArticleId: candidate.id,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    status: "updated",
    trigger,
    skipReason: null,
    originalLength,
    extractedLength: extraction.text.length,
    httpStatus: extraction.httpStatus,
    error: null,
  };
}

function getCompletionTrigger(candidate: RawArticleCompletionCandidate): CompletionTrigger | null {
  const content = candidate.contentText?.trim() ?? "";
  if (!content) {
    return "empty_content";
  }

  if (PLACEHOLDER_CONTENT.has(content.toLowerCase())) {
    return "invalid_placeholder";
  }

  if (candidate.sourceCategory === "long-form" && content.length < LONG_FORM_SHORT_CONTENT_CHARS) {
    return "short_long_form";
  }

  return null;
}

async function extractReadableText(url: string): Promise<ExtractionResult> {
  const fetched = await fetchHtml(url);
  if (!fetched.html) {
    return {
      httpStatus: fetched.httpStatus,
      finalUrl: fetched.finalUrl,
      htmlFetched: false,
      text: "",
      error: fetched.error,
    };
  }

  const dom = new JSDOM(fetched.html, { url: fetched.finalUrl });
  const article = new Readability(dom.window.document).parse();
  const text = cleanText(article?.textContent ?? "");

  return {
    httpStatus: fetched.httpStatus,
    finalUrl: fetched.finalUrl,
    htmlFetched: true,
    text,
    error: null,
  };
}

async function fetchHtml(url: string): Promise<{
  httpStatus: number | null;
  finalUrl: string;
  html: string;
  error: string | null;
}> {
  return domainLimiter.run(url, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent":
            "Mozilla/5.0 (compatible; X-AI-field content completion; +https://example.local/content-completion)",
        },
      });
      const contentType = response.headers.get("content-type") ?? "";
      const html =
        contentType.includes("text/html") || contentType.includes("application/xhtml")
          ? await response.text()
          : "";

      return {
        httpStatus: response.status,
        finalUrl: response.url,
        html,
        error: null,
      };
    } catch (error) {
      return {
        httpStatus: null,
        finalUrl: url,
        html: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  });
}

async function updateRawArticleContent(client: PoolClient, id: string, contentText: string) {
  await client.query(
    `
      update raw_articles
      set content_text = $1
      where id = $2
    `,
    [contentText, id],
  );
}

function isMeaningfulImprovement(current: string | null, extracted: string): boolean {
  const currentLength = normalizedLength(current);
  if (extracted.length < MIN_EXTRACTED_TEXT_CHARS) {
    return false;
  }

  return extracted.length >= currentLength + MIN_IMPROVEMENT_CHARS;
}

function isSuccessfulStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function isBlockedOrChallengeText(text: string): boolean {
  const normalized = text.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => normalized.includes(marker));
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedLength(value: string | null): number {
  return value?.trim().length ?? 0;
}

function skippedResult(
  candidate: RawArticleCompletionCandidate,
  trigger: CompletionTrigger | null,
  originalLength: number,
  skipReason: string,
): ContentCompletionResult {
  return {
    rawArticleId: candidate.id,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    status: "skipped",
    trigger,
    skipReason,
    originalLength,
    extractedLength: null,
    httpStatus: null,
    error: null,
  };
}

function failedResult(
  candidate: RawArticleCompletionCandidate,
  trigger: CompletionTrigger,
  originalLength: number,
  extraction: ExtractionResult,
  error: string,
): ContentCompletionResult {
  return {
    rawArticleId: candidate.id,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    status: "failed",
    trigger,
    skipReason: null,
    originalLength,
    extractedLength: extraction.text.length,
    httpStatus: extraction.httpStatus,
    error,
  };
}

class DomainRateLimiter {
  private readonly lastRequestByDomain = new Map<string, number>();
  private readonly queueByDomain = new Map<string, Promise<unknown>>();

  constructor(private readonly delayMs: number) {}

  async run<T>(url: string, task: () => Promise<T>): Promise<T> {
    const domain = getDomain(url);
    const previous = this.queueByDomain.get(domain) ?? Promise.resolve();
    const current = previous.then(async () => {
      const lastRequestAt = this.lastRequestByDomain.get(domain) ?? 0;
      const waitMs = Math.max(0, this.delayMs - (Date.now() - lastRequestAt));
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.lastRequestByDomain.set(domain, Date.now());
      return task();
    });

    this.queueByDomain.set(
      domain,
      current.catch(() => {
        // Keep the per-domain queue moving even when one request fails.
      }),
    );

    return current;
  }
}

const domainLimiter = new DomainRateLimiter(DOMAIN_DELAY_MS);

function getDomain(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await task(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}
