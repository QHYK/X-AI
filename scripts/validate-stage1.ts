import { mkdir, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool } from "pg";
import { runStage1LlmValidation } from "../src/processing/stage1-llm.js";
import type { Stage1ArticleRow } from "../src/processing/stage1-contract.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type ValidationSample = Stage1ArticleRow & {
  sampleCategory: string;
};

type ValidationReport = {
  generatedAt: string;
  model: string;
  sampleCount: number;
  sampleCategoryCounts: Record<string, number>;
  successCount: number;
  failureCount: number;
  retryCount: number;
  results: Array<{
    rawArticleId: string;
    sampleCategory: string;
    source: string;
    title: string;
    url: string | null;
    inputPreview: {
      title: string;
      url: string | null;
      author: string | null;
      sourceName: string;
      sourceTags: string[] | null;
      contentLength: number;
      sourceMetadata: Record<string, unknown>;
    };
    success: boolean;
    attempts: number;
    output: unknown;
    error: string | null;
  }>;
};

type QueryRow = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  contentText: string | null;
  publishedAt: Date | null;
  sourceTags: string[] | null;
  sourceName: string;
  sourceCategory: string;
  sourceType: string | null;
  sourcePriority: string;
  eventCandidate: boolean;
  sourceDigestCandidate: boolean;
  sourceAvailability: string | null;
  sourceLanguage: string;
};

const REPORT_PATH =
  process.env.STAGE1_VALIDATION_REPORT_PATH ?? "docs/spikes/stage1-validation-report.json";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const CONCURRENCY = Number(process.env.STAGE1_VALIDATION_CONCURRENCY ?? 2);
const SAMPLE_LIMIT = Number(process.env.STAGE1_VALIDATION_SAMPLE_LIMIT ?? 24);

const SAMPLE_GROUPS: Array<{
  category: string;
  limit: number;
  whereSql: string;
}> = [
  {
    category: "tier1_important_news",
    limit: 3,
    whereSql: `
      s.source_type = 'Tier-1 media'
      and s.category in ('Finance & Economy', 'Technology', 'General', 'Politics', 'Company')
      and coalesce(length(ra.content_text), 0) >= 80
    `,
  },
  {
    category: "macro_policy",
    limit: 3,
    whereSql: `
      (
        s.category = 'Policy'
        or s.name ilike any(array['%Fed%', '%ECB%', '%BLS%', '%BEA%', '%CPI%', '%PPI%', '%CME%'])
      )
    `,
  },
  {
    category: "geopolitics",
    limit: 3,
    whereSql: `
      (
        ra.title ilike any(array['%war%', '%Israel%', '%Iran%', '%China%', '%Ukraine%', '%Russia%', '%tariff%', '%sanction%'])
        or ra.content_text ilike any(array['%war%', '%Israel%', '%Iran%', '%China%', '%Ukraine%', '%Russia%', '%tariff%', '%sanction%'])
      )
    `,
  },
  {
    category: "technology",
    limit: 4,
    whereSql: `
      s.category = 'Technology'
      and coalesce(length(ra.content_text), 0) >= 80
    `,
  },
  {
    category: "science_papers",
    limit: 3,
    whereSql: `
      s.category = 'Science'
      and s.source_type = 'Scientific Journal'
    `,
  },
  {
    category: "long_form",
    limit: 3,
    whereSql: `
      s.category = 'long-form'
    `,
  },
  {
    category: "tier1_exclusive",
    limit: 2,
    whereSql: `
      s.source_type = 'Tier-1 media'
      and (
        ra.title ilike '%exclusive%'
        or ra.content_text ilike '%exclusive%'
      )
    `,
  },
  {
    category: "likely_ignore_or_edge",
    limit: 5,
    whereSql: `
      (
        s.name in ('xkcd', 'NASA Image of the Day')
        or ra.title ilike any(array['%promo code%', '%best movies%', '%discount%', '%coupon%', '%horoscope%'])
        or coalesce(length(ra.content_text), 0) < 20
      )
    `,
  },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to validate Stage 1 LLM integration.");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to load Stage 1 validation samples.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  try {
    const samples = await loadValidationSamples(pool);
    const results = await runWithConcurrency(samples, Math.max(1, CONCURRENCY), async (sample) => {
      console.log(
        `VALIDATING ${sample.sampleCategory}: ${sample.sourceName} - ${sample.title}`,
      );
      const result = await runStage1LlmValidation(sample, { model: MODEL });

      if (result.success) {
        console.log(
          JSON.stringify(
            {
              rawArticleId: sample.id,
              source: sample.sourceName,
              title: sample.title,
              routing: result.output.routing,
              category: result.output.category,
              validation: "success",
              attempts: result.attempts,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          JSON.stringify(
            {
              rawArticleId: sample.id,
              source: sample.sourceName,
              title: sample.title,
              validation: "failure",
              attempts: result.attempts,
              error: result.error,
            },
            null,
            2,
          ),
        );
      }

      return { sample, result };
    });

    const report: ValidationReport = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      sampleCount: samples.length,
      sampleCategoryCounts: countBy(samples, (sample) => sample.sampleCategory),
      successCount: results.filter(({ result }) => result.success).length,
      failureCount: results.filter(({ result }) => !result.success).length,
      retryCount: results.reduce((sum, { result }) => sum + Math.max(0, result.attempts - 1), 0),
      results: results.map(({ sample, result }) => ({
        rawArticleId: sample.id,
        sampleCategory: sample.sampleCategory,
        source: sample.sourceName,
        title: sample.title,
        url: sample.url,
        inputPreview: {
          title: result.input.title,
          url: result.input.url,
          author: result.input.author,
          sourceName: result.input.source_name,
          sourceTags: result.input.source_tags,
          contentLength: result.input.content.length,
          sourceMetadata: result.input.source_metadata,
        },
        success: result.success,
        attempts: result.attempts,
        output: result.success ? result.output : null,
        error: result.success ? null : result.error,
      })),
    };

    await mkdir("docs/spikes", { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Stage 1 validation report written to ${REPORT_PATH}`);
    console.log(
      JSON.stringify(
        {
          model: report.model,
          sampleCount: report.sampleCount,
          sampleCategoryCounts: report.sampleCategoryCounts,
          successCount: report.successCount,
          failureCount: report.failureCount,
          retryCount: report.retryCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

async function loadValidationSamples(pool: Pool): Promise<ValidationSample[]> {
  const samples: ValidationSample[] = [];
  const selectedIds = new Set<string>();

  for (const group of SAMPLE_GROUPS) {
    if (samples.length >= SAMPLE_LIMIT) {
      break;
    }

    const rows = await querySamplesForGroup(
      pool,
      group.whereSql,
      Math.min(group.limit, SAMPLE_LIMIT - samples.length),
      [...selectedIds],
    );

    for (const row of rows) {
      if (selectedIds.has(row.id)) {
        continue;
      }

      selectedIds.add(row.id);
      samples.push(toValidationSample(row, group.category));
    }
  }

  return samples;
}

async function querySamplesForGroup(
  pool: Pool,
  whereSql: string,
  limit: number,
  excludeIds: string[],
): Promise<QueryRow[]> {
  const result = await pool.query<QueryRow>(
    `
      select
        ra.id,
        ra.title,
        ra.url,
        ra.author,
        ra.content_text as "contentText",
        ra.published_at as "publishedAt",
        ra.source_tags as "sourceTags",
        s.name as "sourceName",
        s.category as "sourceCategory",
        s.source_type as "sourceType",
        s.priority as "sourcePriority",
        s.event_candidate as "eventCandidate",
        s.source_digest_candidate as "sourceDigestCandidate",
        s.availability as "sourceAvailability",
        s.language as "sourceLanguage"
      from raw_articles ra
      join sources s on s.id = ra.source_id
      where ra.stage1_status = 'pending'
        and not (ra.id = any($1::uuid[]))
        and (${whereSql})
      order by
        case when s.priority = 'High' then 0 when s.priority = 'Medium' then 1 else 2 end,
        coalesce(length(ra.content_text), 0) desc,
        coalesce(ra.published_at, ra.collected_at) desc
      limit $2
    `,
    [excludeIds, limit],
  );

  return result.rows;
}

function toValidationSample(row: QueryRow, sampleCategory: string): ValidationSample {
  return {
    ...row,
    sampleCategory,
  };
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
