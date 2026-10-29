import {
  productionPrompt,
  withPromptBindings,
  claimManualPrompt,
  finishManualPrompt,
  PromptAttemptBusyError,
  logPromptError,
} from './prompts/runtime.js';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  getOrFetchArticle,
  readStoredArticle,
  normalizedFetchUrl,
  type ArticleDatabase,
  type ArticleDocument,
} from './article-fetch-cache.js';
import { fetchDiscoveryArticle } from '../discovery/fetch-content.js';
import { coverFromRawArticle } from '../discovery/article-cover.js';
import {
  DiscoveryTagsSchema,
  DiscoveryTagsTransportSchema,
  readDiscoveryContentMetadata,
} from './discovery-content-metadata.js';
import { resolveDiscoveryPublication } from './discovery-source.js';
import { loadDiscoverySources } from './discovery-source-list.js';
import {
  getInDepthReviewItem,
  saveInDepthEditorial,
  type InDepthReviewItem,
} from './in-depth-reads.js';
import {
  EditorialIntroductionSchema,
  EditorialConflictError,
  readEditorialIntroduction,
  type EditorialIntroduction,
} from './in-depth-editorial.js';
import { IntroductionError } from './in-depth-introduction.js';
import {
  createLlmClient,
  resolveLlmProvider,
  resolveProviderLlmModel,
} from '../processing/llm-client.js';

export const ManualCandidateInput = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .transform((url, ctx) => {
        try {
          return normalizedFetchUrl(url);
        } catch {
          ctx.addIssue({ code: 'custom', message: '请输入无凭据的 HTTP(S) URL。' });
          return z.NEVER;
        }
      }),
    tags: DiscoveryTagsSchema.optional().default([]),
  })
  .strict();

const ManualOutputSchema = EditorialIntroductionSchema.extend({
  title_zh: z.string().min(1).max(2000),
  tags: DiscoveryTagsTransportSchema,
}).strict();

type MetadataRow = {
  title: string | null;
  title_zh: string | null;
  author: string | null;
  publication: string | null;
  content_type: string | null;
  published_at: string | null;
  summary: string | null;
  why_worth_reading: string | null;
  evidence: Record<string, unknown> | null;
  evaluation: Record<string, unknown> | null;
  source_content_id: string | null;
};
type Queryable = Pick<Pool, 'query'>;
type Request = ReturnType<typeof createLlmClient>['structured']['create'];

/** Also matches legacy review rows without normalized_url; never alters the existing work. */
async function existingCandidate(db: Queryable, url: string): Promise<string | null> {
  const result = await db.query<{ id: string; url: string; normalized_url: string | null }>(
    `select idc.id, dc.url, dc.normalized_url from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where dc.normalized_url = $1 or dc.url = $1 or dc.normalized_url is null or dc.normalized_url = ''
      order by idc.created_at desc, idc.id desc`,
    [url],
  );
  return (
    result.rows.find((row) => {
      try {
        return row.normalized_url === url || normalizedFetchUrl(row.url) === url;
      } catch {
        return false;
      }
    })?.id ?? null
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function legacyArticle(row: MetadataRow | undefined, url: string): ArticleDocument | null {
  const fetch = row?.evidence?.fetch as Record<string, unknown> | undefined;
  if (
    !fetch ||
    fetch.status !== 'success' ||
    fetch.truncated !== false ||
    (fetch.contentComplete !== true && fetch.content_complete !== true) ||
    (fetch.contentType ?? fetch.content_type) !== 'article_body' ||
    !text(fetch.content)
  )
    return null;
  return {
    url,
    finalUrl: url,
    fetchedAt: new Date().toISOString(),
    status: 'success',
    markdown: String(fetch.content),
    isComplete: true,
    metadata: {},
    coverImage: readDiscoveryContentMetadata(row!).cover,
    error: null,
    origin: 'candidate',
  };
}

export async function createManualInDepthCandidate(
  db: ArticleDatabase,
  rawInput: unknown,
  options: { fetchDocument?: (url: string) => Promise<ArticleDocument> } = {},
): Promise<{ item: InDepthReviewItem; existing: boolean }> {
  const input = ManualCandidateInput.parse(rawInput);
  const returnItem = async (id: string, existing: boolean) => {
    const item = await getInDepthReviewItem(db, id);
    if (!item) throw new IntroductionError('Candidate not found after creation.', 503);
    return { item, existing };
  };
  const existing = await existingCandidate(db, input.url);
  if (existing) return returnItem(existing, true);
  const metadata = await db.query<MetadataRow>(
    `select title, title_zh, author, publication, content_type, published_at, summary,
            why_worth_reading, evidence, evaluation,
            case when source_content_type = 'processed_content' then source_content_id end as source_content_id
       from discovery_candidates where normalized_url = $1 or url = $1
       order by updated_at desc, id desc limit 1`,
    [input.url],
  );
  const originalUrl = String((rawInput as { url: string }).url).trim();
  const dailyMetadata = metadata.rows[0]
    ? null
    : await db.query<MetadataRow>(
        `select ra.title, pc.title_zh, ra.author, s.name as publication,
            null::text as content_type, ra.published_at, coalesce(pc.summary_zh, pc.summary) as summary,
            null::text as why_worth_reading,
            jsonb_build_object('rawMetadata', ra.metadata, 'imageUrl', ra.image_url) as evidence,
            null::jsonb as evaluation, pc.id as source_content_id
       from raw_articles ra join sources s on s.id = ra.source_id
       left join processed_contents pc on pc.raw_article_id = ra.id
      where ra.url = any($1::text[]) order by ra.collected_at desc, ra.id desc limit 1`,
        [[originalUrl, input.url]],
      );
  const prior = metadata.rows[0] ?? dailyMetadata?.rows[0];
  const candidateArticle = legacyArticle(prior, input.url);
  // Keep the original input URL for Daily records whose stored URL contains tracking parameters.
  const article = await getOrFetchArticle(db, originalUrl, {
    sourceContentId: prior?.source_content_id,
    fetchDocument: async () =>
      candidateArticle ??
      (options.fetchDocument
        ? options.fetchDocument(originalUrl)
        : fetchDiscoveryArticle(originalUrl, { maxRetries: 0 })),
  });
  if (article.status !== 'success' || !article.isComplete || !article.markdown.trim())
    throw new IntroductionError(article.error || '原文不可用或不完整，未创建候选。', 422);
  if (article.cacheWarning)
    throw new IntroductionError('正文已获取但缓存保存失败，未创建候选，请检查数据库。', 503);
  const m = article.metadata;
  const publication = resolveDiscoveryPublication({
    url: input.url,
    metadata: m,
    publication: prior?.publication,
    sources: await loadDiscoverySources(db),
  });
  const tags = input.tags.length ? input.tags : readDiscoveryContentMetadata(prior ?? {}).tags;
  const published = prior?.published_at ?? m.publishedTime ?? m.published_time;
  const publishedAt =
    published && Number.isFinite(Date.parse(String(published)))
      ? new Date(String(published)).toISOString()
      : null;
  const cover =
    article.coverImage ??
    readDiscoveryContentMetadata(prior ?? {}).cover ??
    coverFromRawArticle(prior?.evidence?.imageUrl, originalUrl, prior?.evidence?.rawMetadata);
  const canonical = normalizedFetchUrl(article.finalUrl);
  const client = await db.connect();
  let id: string;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `manual-candidate:${canonical}`,
    ]);
    const duplicate =
      (await existingCandidate(client, canonical)) ?? (await existingCandidate(client, input.url));
    if (duplicate) {
      await client.query('commit');
      return returnItem(duplicate, true);
    }
    const candidate = await client.query<{ id: string }>(
      `insert into discovery_candidates
         (run_id, discovery_path, url, normalized_url, title, title_zh, author, publication,
          content_type, published_at, summary, why_worth_reading, evidence, evaluation, status)
       values (null, 'manual', $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11::jsonb, $12::jsonb, 'discovered')
       returning id`,
      [
        originalUrl,
        canonical,
        prior?.title ?? text(m.title),
        prior?.title_zh ?? text(m.title_zh),
        prior?.author ?? text(m.author),
        publication,
        prior?.content_type ?? 'article',
        publishedAt,
        prior?.summary ?? null,
        prior?.why_worth_reading ?? null,
        JSON.stringify({
          contentUrl: article.origin === 'daily' ? article.finalUrl : article.url,
          contentOrigin: article.origin,
          coverImage: cover,
          sourceMetadata: m,
          fetch: {
            status: 'success',
            contentComplete: true,
            truncated: false,
            returnedContentLength: article.markdown.length,
          },
        }),
        JSON.stringify({ tags, manualTags: input.tags.length > 0, manualGenerated: false }),
      ],
    );
    if (!candidate.rows[0]) throw new Error('Manual candidate insert returned no ID.');
    const review = await client.query<{ id: string }>(
      `insert into in_depth_candidates (discovery_candidate_id, review_status) values ($1::uuid, 'pending') returning id`,
      [candidate.rows[0].id],
    );
    if (!review.rows[0]) throw new Error('Manual review insert returned no ID.');
    id = review.rows[0].id;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return returnItem(id, false);
}

/** Claim in a short transaction, generate outside it, then compare-and-save atomically. */
export async function generateManualInDepthIntroduction(
  db: ArticleDatabase,
  id: string,
  options: { request?: Request; regenerate?: boolean } = {},
): Promise<EditorialIntroduction> {
  let client = await db.connect();
  let released = false;
  let llm: ReturnType<typeof createLlmClient> | null = null;
  let generated: EditorialIntroduction | undefined;
  let claimedId: string | undefined;
  let claimFinished = false;
  try {
    await client.query('begin');
    const lock = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked',
      [`manual-generate:${id}`],
    );
    if (!lock.rows[0]?.locked)
      throw new IntroductionError('该候选正在生成，请等待完成后刷新。', 409);
    const result = await client.query<
      MetadataRow & {
        candidate_id: string;
        url: string;
        editorial_summary: string | null;
        editorial_why_worth_reading: string | null;
        editorial_extra_info: string | null;
      }
    >(
      `select dc.*, dc.id as candidate_id, idc.editorial_summary, idc.editorial_why_worth_reading, idc.editorial_extra_info
         from in_depth_candidates idc join discovery_candidates dc on dc.id = idc.discovery_candidate_id
        where idc.id = $1::uuid and dc.discovery_path = 'manual'`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new IntroductionError('Manual candidate not found.', 404);
    const saved = readEditorialIntroduction({
      summary: row.editorial_summary,
      whyWorthReading: row.editorial_why_worth_reading,
      extra_info: row.editorial_extra_info,
    });
    if (
      !options.regenerate &&
      row.evaluation?.manualGenerated === true &&
      row.title_zh &&
      saved.summary.trim() &&
      saved.whyWorthReading.trim() &&
      saved.extra_info.trim()
    ) {
      await client.query('commit');
      return saved;
    }
    const article = await readStoredArticle(client, text(row.evidence?.contentUrl) ?? row.url, {
      sourceContentId: row.source_content_id,
      candidateArticle: legacyArticle(row, row.url),
    });
    if (!article?.isComplete || !article.markdown.trim() || article.markdown.length > 60_000)
      throw new IntroductionError(
        '没有可用的完整正文或正文超过单次输入上限；未抓取或调用模型。',
        422,
      );
    const boundVersion = await claimManualPrompt(
      client,
      'candidate',
      row.candidate_id,
      'in_depth.manual.generate',
      false,
    );
    try {
      await client.query('commit');
    } catch (error) {
      logPromptError('in_depth.manual.generate', 'binding');
      throw error;
    }
    claimedId = row.candidate_id;
    client.release();
    released = true;
    const prompt = await withPromptBindings(
      db,
      async () => boundVersion,
      () =>
        productionPrompt(
          'in_depth.manual.generate',
          JSON.stringify({
            originalUrl: row.url,
            title: row.title,
            author: row.author,
            source: row.publication,
            sourceMetadata: article.metadata,
            content: article.markdown,
            contentComplete: true,
            tags: readDiscoveryContentMetadata(row).tags,
          }),
        ),
      { binding: 'active' },
    );
    const provider = resolveLlmProvider(
      process.env.DISCOVERY_LLM_PROVIDER?.trim() || process.env.LLM_PROVIDER,
    );
    const model = resolveProviderLlmModel(provider);
    if (!options.request) llm = createLlmClient({ provider, maxRetries: 0, timeoutMs: 120_000 });
    let output: z.infer<typeof ManualOutputSchema>;
    try {
      const response = await (options.request ?? llm!.structured.create)({
        model,
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        input: prompt.input,
        max_output_tokens: 8000,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'manual_in_depth',
            schema: z.toJSONSchema(ManualOutputSchema),
            strict: true,
          },
        },
      });
      output = ManualOutputSchema.parse(JSON.parse(response.output_text));
      for (const value of [
        output.title_zh,
        output.summary,
        output.whyWorthReading,
        output.extra_info,
      ])
        if (!value.trim() || !/\p{Script=Han}/u.test(value))
          throw new Error('Expected nonempty Chinese introduction.');
      output.tags = DiscoveryTagsSchema.parse(output.tags);
      console.info('Manual In-depth generation', {
        id,
        provider,
        model,
        promptVersion: prompt.versionId,
        usage: response.usage,
        apiMode: response.api_mode,
      });
    } catch (error) {
      console.error('Manual In-depth generation failed.', error);
      throw new IntroductionError('生成失败或正文证据不足，未保存介绍。', 502);
    }
    generated = {
      summary: output.summary.trim(),
      whyWorthReading: output.whyWorthReading.trim(),
      extra_info: output.extra_info.trim(),
    };
    let tags = row.evaluation?.manualTags ? readDiscoveryContentMetadata(row).tags : [];
    // Keep human choices first; reuse the bilingual contract to deduplicate additions.
    for (const tag of output.tags) {
      if (tags.length === 3) break;
      tags = DiscoveryTagsSchema.parse([...tags, tag]);
    }
    client = await db.connect();
    released = false;
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `manual-generate:${id}`,
    ]);
    const candidate = await client.query(
      `update discovery_candidates set title_zh = $2, summary = $3, why_worth_reading = $4,
         status = 'evaluated', evaluation = coalesce(evaluation, '{}'::jsonb) || $5::jsonb, updated_at = now()
        where id = $1::uuid`,
      [
        row.candidate_id,
        output.title_zh.trim(),
        generated.summary,
        generated.whyWorthReading,
        JSON.stringify({ tags, manualGenerated: true }),
      ],
    );
    if (candidate.rowCount !== 1) throw new Error('Candidate disappeared.');
    if (!(await saveInDepthEditorial(client, id, generated, saved)))
      throw new Error('Review candidate disappeared.');
    await finishManualPrompt(client, 'candidate', row.candidate_id, 'completed');
    await client.query('commit');
    claimFinished = true;
    return generated;
  } catch (error) {
    if (!released) {
      await client.query('rollback');
      client.release();
      released = true;
    }
    if (claimedId && !claimFinished) {
      try {
        await finishManualPrompt(db, 'candidate', claimedId, 'failed');
      } catch (failure) {
        console.error(
          'Manual Prompt attempt recovery failed; needs operator verification.',
          failure,
        );
      }
    }
    if (error instanceof EditorialConflictError)
      throw new IntroductionError(error.message, 409, generated, error.currentEditorial);
    if (error instanceof PromptAttemptBusyError) throw new IntroductionError(error.message, 409);
    if (error instanceof IntroductionError) throw error;
    console.error('Manual In-depth persistence failed.', error);
    throw new IntroductionError(
      generated
        ? '介绍已生成但保存失败，请使用 Save changes 保存文本。'
        : '候选读取失败，请检查数据库。',
      503,
      generated,
    );
  } finally {
    await llm?.close();
    if (!released) client.release();
  }
}
