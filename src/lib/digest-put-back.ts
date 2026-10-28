import { readSystemFragmentSnapshot } from './prompts/system-fragments.js';
import {
  productionPrompt,
  withPromptBindings,
  claimManualPrompt,
  finishManualPrompt,
  PromptAttemptBusyError,
  logPromptError,
} from './prompts/runtime.js';
import { z } from 'zod';
import { normalizeArticleUrl } from '../processing/url-normalization.js';
import type { Pool, PoolClient } from 'pg';
import {
  deriveDailyDateFromPublishedAt,
  resolveDailyScope,
  isDailyScopeCompleted,
} from './daily-scope.js';
import { readStoredArticle } from './article-fetch-cache.js';
import { lockDigestOrder } from './digest-order.js';
import { stage1OutputJsonSchema, MAX_STAGE1_TAGS } from '../processing/stage1-contract.js';
import {
  createLlmClient,
  resolveStageLlmProvider,
  resolveStageLlmModel,
} from '../processing/llm-client.js';

export const PutBackInput = z.object({ id: z.uuid(), date: z.iso.date() }).strict();
const ChineseText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((s) => /\p{Script=Han}/u.test(s), 'Expected Chinese text.');
export const PutBackFieldsSchema = z
  .object({
    category: z.enum(stage1OutputJsonSchema.properties.category.enum).exclude(['Long-form']),
    title_zh: ChineseText(2000),
    summary: z.string().trim().min(1).max(8000),
    summary_zh: ChineseText(8000),
    tags: z.array(z.string().trim().min(1).max(120)).max(MAX_STAGE1_TAGS),
  })
  .strict();
export type PutBackFields = z.infer<typeof PutBackFieldsSchema>;
export class PutBackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly generatedFields?: PutBackFields,
  ) {
    super(message);
  }
}
type ArticleRow = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: Date | string | null;
  stage1_status: string;
  processing_error: string | null;
  source_name: string;
  source_category: string;
  content_text: string | null;
  full_content_text: string | null;
  metadata: Record<string, unknown> | null;
  processed_id: string | null;
  daily_date: string | null;
  routing: string | null;
  category: string | null;
  title_zh: string | null;
  summary: string | null;
  summary_zh: string | null;
  tags: string[] | null;
  ai_rank: number | null;
  display_rank: number | null;
  put_back_at: Date | string | null;
  linked_event: boolean;
};
export type PutBackResult = {
  id: string;
  rawArticleId: string;
  dailyDate: string;
  category: string;
  rank: number;
  putBackAt: string | null;
  alreadyInDigest: boolean;
};
type Database = Pick<Pool, 'connect' | 'query'>;
type Request = ReturnType<typeof createLlmClient>['structured']['create'];

async function loadArticle(client: Pick<PoolClient, 'query'>, id: string): Promise<ArticleRow> {
  const result = await client.query<ArticleRow>(
    `select ra.id, ra.title, ra.url, ra.author, ra.published_at, ra.stage1_status,
            ra.processing_error, ra.content_text, ra.full_content_text, ra.metadata,
            s.name as source_name, s.category as source_category,
            pc.id as processed_id, pc.daily_date::text, pc.routing, pc.category, pc.title_zh,
            pc.summary, pc.summary_zh, pc.tags, pc.ai_rank, pc.display_rank, pc.put_back_at,
            (pc.event_id is not null or exists (
              select 1 from event_group_items egi where egi.processed_content_id = pc.id
            )) as linked_event
       from raw_articles ra join sources s on s.id = ra.source_id
       left join processed_contents pc on pc.raw_article_id = ra.id
      where ra.id = $1::uuid for update of ra`,
    [id],
  );
  if (!result.rows[0]) throw new PutBackError('Article not found.', 404);
  return result.rows[0];
}
function validateDate(row: ArticleRow, date: string, now: Date): void {
  if (!row.daily_date && !row.published_at)
    throw new PutBackError('缺少发布时间，无法确认所属 Daily。', 422);
  const actual = row.daily_date ?? deriveDailyDateFromPublishedAt(row.published_at!);
  if (actual !== date)
    throw new PutBackError(`文章所属 Daily 为 ${actual}，不能恢复到 ${date}。`, 409);
  if (!isDailyScopeCompleted(resolveDailyScope(actual), now))
    throw new PutBackError('该 Daily 时间窗口尚未结束。', 409);
}
function isVisibleDigest(row: ArticleRow): boolean {
  return row.routing === 'digest' && (row.display_rank ?? row.ai_rank) !== null;
}
function result(row: ArticleRow, alreadyInDigest: boolean): PutBackResult {
  return {
    id: row.processed_id!,
    rawArticleId: row.id,
    dailyDate: row.daily_date!,
    category: row.category!,
    rank: row.display_rank ?? row.ai_rank!,
    putBackAt: row.put_back_at ? new Date(row.put_back_at).toISOString() : null,
    alreadyInDigest,
  };
}
function fieldsFromRow(row: ArticleRow): PutBackFields | null {
  const parsed = PutBackFieldsSchema.safeParse({
    category: row.category,
    title_zh: row.title_zh,
    summary: row.summary,
    summary_zh: row.summary_zh,
    tags: row.tags ?? [],
  });
  return parsed.success ? parsed.data : null;
}
function cachedFields(row: ArticleRow, date: string): PutBackFields | null {
  const draft = row.metadata?.put_back_preparation;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const value = draft as Record<string, unknown>;
  if (value.dailyDate !== date) return null;
  const fields = PutBackFieldsSchema.safeParse(value.fields);
  return fields.success ? fields.data : null;
}
async function lockArticle(client: PoolClient, id: string): Promise<void> {
  const lock = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked',
    [`digest-put-back:${id}`],
  );
  if (!lock.rows[0]?.locked) throw new PutBackError('该文章正在恢复，请等待完成后刷新。', 409);
}
async function existingDigestWork(
  client: PoolClient,
  row: ArticleRow,
  date: string,
): Promise<PutBackResult | null> {
  if (!row.url) return null;
  const normalized = normalizeArticleUrl(row.url);
  const locked = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked',
    [`digest-put-back-url:${date}:${normalized}`],
  );
  if (!locked.rows[0]?.locked) throw new PutBackError('相同作品正在恢复，请等待完成后刷新。', 409);
  // The URL transaction lock serializes claims; the committed marker survives while LLM runs.
  const running = await client.query<{ id: string; url: string | null }>(
    `select id, url from raw_articles
      where id <> $1::uuid and metadata->'promptAttempt'->>'status' = 'running'
        and metadata->'promptAttempt'->>'key' = 'daily.editorial.digest_put_back'`,
    [row.id],
  );
  if (running.rows.some((item) => item.url && normalizeArticleUrl(item.url) === normalized))
    throw new PutBackError('相同作品正在恢复，请等待完成后刷新。', 409);
  const matches = await client.query<{
    id: string;
    url: string | null;
    category: string;
    rank: number;
    put_back_at: Date | string | null;
  }>(
    `select pc.id, ra.url, pc.category, coalesce(pc.display_rank, pc.ai_rank) as rank, pc.put_back_at
       from processed_contents pc join raw_articles ra on ra.id = pc.raw_article_id
      where pc.daily_date = $1::date and pc.routing = 'digest'
        and coalesce(pc.display_rank, pc.ai_rank) is not null`,
    [date],
  );
  const existing = matches.rows.find(
    (item) => item.url && normalizeArticleUrl(item.url) === normalized,
  );
  return existing
    ? {
        id: existing.id,
        rawArticleId: row.id,
        dailyDate: date,
        category: existing.category,
        rank: existing.rank,
        putBackAt: existing.put_back_at ? new Date(existing.put_back_at).toISOString() : null,
        alreadyInDigest: true,
      }
    : null;
}

function assertRestorable(row: ArticleRow): void {
  if (row.stage1_status !== 'ignored')
    throw new PutBackError('文章已不是 Ignored，请刷新后确认当前状态。', 409);
  if (row.linked_event)
    throw new PutBackError('已有处理结果关联 Event，不能直接改为 Digest，请先核查。', 409);
}

/** Durable preparation transaction, followed by atomic publication. */
export async function putBackIgnoredArticle(
  db: Database,
  rawInput: unknown,
  options: { request?: Request; now?: Date } = {},
): Promise<PutBackResult> {
  const input = PutBackInput.parse(rawInput);
  const now = options.now ?? new Date();
  let client = await db.connect();
  let released = false;
  let model: ReturnType<typeof createLlmClient> | null = null;
  let fields: PutBackFields | undefined;
  let preparationSaved = false;
  let claimed = false;
  let claimFinished = false;
  try {
    await client.query('begin');
    await lockArticle(client, input.id);
    let row = await loadArticle(client, input.id);
    validateDate(row, input.date, now);
    if (isVisibleDigest(row)) {
      if (claimed) await finishManualPrompt(client, 'raw', input.id, 'completed');
      await client.query('commit');
      claimFinished = true;
      return result(row, true);
    }
    assertRestorable(row);
    const duplicate = await existingDigestWork(client, row, input.date);
    if (duplicate) {
      await client.query('commit');
      return duplicate;
    }
    fields = fieldsFromRow(row) ?? cachedFields(row, input.date) ?? undefined;
    if (!fields) {
      let content = [row.full_content_text, row.content_text]
        .find((s) => s && s.trim().length >= 200)
        ?.trim();
      if (!content && row.url) content = (await readStoredArticle(client, row.url))?.markdown;
      if (
        !content ||
        content.trim().length < 200 ||
        /^(?:access denied|forbidden|just a moment|sign in to continue)/i.test(content.trim())
      )
        throw new PutBackError('没有足够的已存正文，未调用模型、未恢复文章。', 422);
      const contentTruncated = content.length > 60_000;
      if (contentTruncated) content = content.slice(0, 60_000);
      const previousVersions = row.metadata?.promptVersions as Record<string, unknown> | undefined;
      const binding = previousVersions?.['daily.editorial.digest_put_back'] ? 'reused' : 'new';
      const boundVersion = await claimManualPrompt(
        client,
        'raw',
        input.id,
        'daily.editorial.digest_put_back',
        true,
      );
      try {
        await client.query('commit');
      } catch (error) {
        logPromptError('daily.editorial.digest_put_back', 'binding');
        throw error;
      }
      claimed = true;
      client.release();
      released = true;
      try {
        const prompt = await withPromptBindings(
          db,
          async () => boundVersion,
          () =>
            productionPrompt(
              'daily.editorial.digest_put_back',
              JSON.stringify({
                title: row.title,
                originalUrl: row.url,
                author: row.author,
                source: row.source_name,
                category: row.category ?? row.source_category,
                content,
                contentTruncated,
              }),
            ),
          {
            binding,
            systemFragments: async () => {
              const saved = await db.query<{ metadata: Record<string, unknown> }>(
                'select metadata from raw_articles where id = $1::uuid',
                [input.id],
              );
              return readSystemFragmentSnapshot(saved.rows[0]?.metadata?.systemFragmentVersions);
            },
          },
        );
        const provider = resolveStageLlmProvider('stage1');
        const name = resolveStageLlmModel('stage1');
        if (!options.request)
          model = createLlmClient({ provider, maxRetries: 0, timeoutMs: 120_000 });
        const response = await (options.request ?? model!.structured.create)({
          model: name,
          ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
          input: prompt.input,
          max_output_tokens: 4000,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: 'digest_put_back',
              strict: true,
              schema: z.toJSONSchema(PutBackFieldsSchema),
            },
          },
        });
        const output = JSON.parse(response.output_text);
        if (output.summary === '' || output.summary_zh === '')
          throw new PutBackError('模型确认正文不足，未恢复文章。', 422);
        fields = PutBackFieldsSchema.parse(output);
        fields.tags = [...new Set(fields.tags)];
        console.info('Digest Put Back generation', {
          id: input.id,
          dailyDate: input.date,
          provider,
          model: name,
          promptVersion: prompt.versionId,
          usage: response.usage,
        });
      } catch (error) {
        if (error instanceof PromptAttemptBusyError) throw new PutBackError(error.message, 409);
        if (error instanceof PutBackError) throw error;
        console.error('Digest Put Back model failed.', error);
        throw new PutBackError('字段生成失败，未恢复文章。', 502);
      }
    }
    if (claimed) {
      client = await db.connect();
      released = false;
      await client.query('begin');
      await lockArticle(client, input.id);
      row = await loadArticle(client, input.id);
      validateDate(row, input.date, now);
      assertRestorable(row);
    }
    const preparation = {
      dailyDate: input.date,
      fields,
      ignoreType: row.processing_error === 'duplicate' ? 'Duplicate' : 'AI Ignored',
    };
    const cached = await client.query(
      `update raw_articles set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb),
         '{put_back_preparation}', $2::jsonb, true) where id = $1::uuid`,
      [input.id, JSON.stringify(preparation)],
    );
    if (cached.rowCount !== 1)
      throw new Error('Preparation cache write did not update the article.');
    await client.query('commit');
    preparationSaved = true;

    await client.query('begin');
    await lockArticle(client, input.id);
    row = await loadArticle(client, input.id);
    validateDate(row, input.date, now);
    if (isVisibleDigest(row)) {
      if (claimed) await finishManualPrompt(client, 'raw', input.id, 'completed');
      await client.query('commit');
      claimFinished = true;
      return result(row, true);
    }
    assertRestorable(row);
    const duplicateAfterPreparation = await existingDigestWork(client, row, input.date);
    if (duplicateAfterPreparation) {
      if (claimed) await finishManualPrompt(client, 'raw', input.id, 'completed');
      await client.query('commit');
      claimFinished = true;
      return duplicateAfterPreparation;
    }
    await lockDigestOrder(client);
    const ranks = await client.query<{ next_rank: number }>(
      `select (coalesce(max(coalesce(display_rank, ai_rank)), 0) + 1)::int as next_rank
         from processed_contents where daily_date = $1::date and category = $2 and routing = 'digest'`,
      [input.date, fields.category],
    );
    const nextRank = ranks.rows[0]?.next_rank;
    if (!nextRank) throw new Error('No append rank returned.');
    const saved = await client.query<{ id: string }>(
      `insert into processed_contents (raw_article_id, daily_date, routing, category,
          title_zh, summary, summary_zh, tags, ai_rank, display_rank, put_back_at)
       values ($1::uuid, $2::date, 'digest', $3, $4, $5, $6, $7::text[], null, $8, clock_timestamp())
       on conflict (raw_article_id) do update set routing = 'digest', category = excluded.category,
          title_zh = excluded.title_zh, summary = excluded.summary, summary_zh = excluded.summary_zh,
          tags = excluded.tags, ai_rank = null, display_rank = excluded.display_rank,
          put_back_at = coalesce(processed_contents.put_back_at, excluded.put_back_at), updated_at = now()
       where processed_contents.daily_date = excluded.daily_date and processed_contents.event_id is null
       returning id`,
      [
        input.id,
        input.date,
        fields.category,
        fields.title_zh,
        fields.summary,
        fields.summary_zh,
        fields.tags,
        nextRank,
      ],
    );
    const id = saved.rows[0]?.id;
    if (!id) throw new PutBackError('现有处理记录归属或关联已变化，未覆盖记录。', 409);
    const raw = await client.query(
      `update raw_articles set stage1_status = 'selected', processing_error = null
        where id = $1::uuid and stage1_status = 'ignored'`,
      [input.id],
    );
    if (raw.rowCount !== 1) throw new PutBackError('文章状态已变化，恢复已回滚。', 409);
    const restored = await loadArticle(client, input.id);
    if (claimed) await finishManualPrompt(client, 'raw', input.id, 'completed');
    await client.query('commit');
    claimFinished = true;
    return result(restored, false);
  } catch (error) {
    if (!released) {
      await client.query('rollback');
      client.release();
      released = true;
    }
    if (claimed && !claimFinished) {
      try {
        await finishManualPrompt(db, 'raw', input.id, 'failed');
      } catch (failure) {
        console.error(
          'Put Back Prompt attempt recovery failed; needs operator verification.',
          failure,
        );
      }
    }
    if (error instanceof PromptAttemptBusyError) throw new PutBackError(error.message, 409);
    if (error instanceof PutBackError) throw error;
    console.error('Digest Put Back persistence failed.', error);
    throw new PutBackError(
      preparationSaved
        ? '恢复写入失败，准备结果已保存；重试将复用结果，不再次生成。'
        : fields
          ? '已生成字段，但准备缓存保存未确认。请保留返回文本，重试可能再次调用模型。'
          : '文章读取失败，未恢复文章。',
      503,
      fields,
    );
  } finally {
    await model?.close();
    if (!released) client.release();
  }
}
