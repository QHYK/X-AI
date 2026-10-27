import { productionPrompt, withPromptBindings, databasePromptBinder } from './prompts/runtime.js';
import { z } from 'zod';
import {
  createLlmClient,
  resolveLlmProvider,
  resolveProviderLlmModel,
} from '../processing/llm-client.js';
import {
  EditorialIntroductionSchema,
  readEditorialIntroduction,
  EditorialConflictError,
  type EditorialIntroduction,
} from './in-depth-editorial.js';
import { fetchDiscoveryArticle } from '../discovery/fetch-content.js';
import {
  getOrFetchArticle,
  type ArticleDocument,
  type ArticleDatabase,
} from './article-fetch-cache.js';
import { saveInDepthEditorial } from './in-depth-reads.js';

type LlmRequest = ReturnType<typeof createLlmClient>['structured']['create'];
const GeneratedSchema = EditorialIntroductionSchema;
const OutputSchema = z.toJSONSchema(GeneratedSchema);

export class IntroductionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly introduction?: EditorialIntroduction,
    readonly currentEditorial?: EditorialIntroduction,
  ) {
    super(message);
  }
}

type SourceRow = {
  candidate_id: string;
  editorial_summary: string | null;
  editorial_why_worth_reading: string | null;
  editorial_extra_info: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  why_worth_reading: string | null;
  evidence: Record<string, unknown> | null;
  url: string;
  source_content_id: string | null;
  publication: string | null;
  published_at: string | null;
};

/** Fixed-URL reading, then one ordinary structured LLM call. No search or Agent loop. */
export async function generateAndSaveInDepthIntroduction(
  db: ArticleDatabase,
  id: string,
  options: { request?: LlmRequest; fetchDocument?: (url: string) => Promise<ArticleDocument> } = {},
): Promise<EditorialIntroduction> {
  const source = await db.query<SourceRow>(
    `select dc.id as candidate_id, dc.title, dc.author, dc.summary, dc.why_worth_reading, dc.evidence,
            dc.url, dc.source_content_id, dc.publication, dc.published_at,
            idc.editorial_summary, idc.editorial_why_worth_reading, idc.editorial_extra_info
       from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where idc.id = $1::uuid`,
    [id],
  );
  const row = source.rows[0];
  if (!row) throw new IntroductionError('Candidate not found.', 404);
  const baseline = readEditorialIntroduction({
    summary: row.editorial_summary,
    whyWorthReading: row.editorial_why_worth_reading,
    extra_info: row.editorial_extra_info,
  });
  const fetch = row.evidence?.fetch;
  const storedFetch =
    fetch && typeof fetch === 'object' && !Array.isArray(fetch)
      ? (fetch as Record<string, unknown>)
      : {};
  const legacyComplete =
    storedFetch.status === 'success' &&
    (storedFetch.contentComplete === true || storedFetch.content_complete === true) &&
    storedFetch.truncated === false &&
    (storedFetch.contentType ?? storedFetch.content_type) === 'article_body' &&
    typeof storedFetch.content === 'string' &&
    storedFetch.content.trim();
  const candidateArticle: ArticleDocument | null = legacyComplete
    ? {
        url: row.url,
        finalUrl: row.url,
        fetchedAt: new Date().toISOString(),
        status: 'success',
        markdown: String(storedFetch.content),
        isComplete: true,
        metadata: {},
        coverImage: null,
        error: null,
        origin: 'candidate',
      }
    : null;
  let article: ArticleDocument;
  try {
    article = await getOrFetchArticle(db, row.url, {
      sourceContentId: row.source_content_id,
      candidateArticle,
      fetchDocument: () =>
        options.fetchDocument
          ? options.fetchDocument(row.url)
          : fetchDiscoveryArticle(row.url, { maxRetries: 0 }),
    });
  } catch (error) {
    console.error('Editorial article loading failed.', error);
    throw new IntroductionError(
      '原文读取或 Fetch Cache 不可用，请检查服务配置及数据库 Migration。未调用介绍模型。',
      503,
    );
  }
  if (article.status !== 'success' || !article.isComplete || !article.markdown.trim()) {
    throw new IntroductionError(
      '原文无法访问或正文不完整，不能生成有充分依据的介绍。未调用介绍模型。',
      422,
    );
  }
  if (article.markdown.length > 60_000)
    throw new IntroductionError(
      '全文超过当前单次介绍输入上限；已保留 Fetch 内容，未截断正文或调用介绍模型。',
      422,
    );
  const prompt = await withPromptBindings(
    db,
    databasePromptBinder(db, 'candidate', row.candidate_id, { fresh: true }),
    () =>
      productionPrompt(
        'in_depth.editorial.introduction',
        JSON.stringify({
          originalUrl: row.url,
          finalUrl: article.finalUrl,
          source: row.publication,
          publishedAt: row.published_at,
          sourceMetadata: article.metadata,
          title: row.title,
          author: row.author,
          content: article.markdown,
          contentComplete: article.isComplete,
          agentSummary: row.summary,
          agentWhyWorthReading: row.why_worth_reading,
          evidence: row.evidence,
        }),
      ),
    { binding: 'active' },
  );
  const provider = resolveLlmProvider(
    process.env.DISCOVERY_LLM_PROVIDER?.trim() || process.env.LLM_PROVIDER,
  );
  const model = resolveProviderLlmModel(provider);
  const client = options.request
    ? null
    : createLlmClient({ provider, maxRetries: 0, timeoutMs: 120_000 });
  let introduction: EditorialIntroduction;
  try {
    const response = await (options.request ?? client!.structured.create)({
      model,
      ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
      input: prompt.input,
      max_output_tokens: 8_000,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'in_depth_introduction',
          schema: OutputSchema,
          strict: true,
        },
      },
    });
    console.info('In-depth introduction generation', {
      id,
      provider,
      model,
      promptVersion: prompt.versionId,
      usage: response.usage,
      apiMode: response.api_mode,
      articleOrigin: article.origin,
      cacheWarning: article.cacheWarning ?? null,
    });
    const output = GeneratedSchema.parse(JSON.parse(response.output_text));
    if (!output.summary.trim() || !output.whyWorthReading.trim())
      throw new IntroductionError(output.extra_info || '原文证据不足，无法生成介绍。', 422);
    for (const text of [output.summary, output.whyWorthReading, output.extra_info]) {
      if (!text.trim() || !/\p{Script=Han}/u.test(text))
        throw new Error('Expected three nonempty Chinese Markdown fields.');
    }
    introduction = {
      extra_info: output.extra_info.trim(),
      summary: output.summary.trim(),
      whyWorthReading: output.whyWorthReading.trim(),
    };
  } catch (error) {
    if (error instanceof IntroductionError) throw error;
    console.error('In-depth introduction generation failed.', error);
    throw new IntroductionError('生成失败，未保存介绍。请检查模型服务或返回内容。', 502);
  } finally {
    await client?.close();
  }
  try {
    if (!(await saveInDepthEditorial(db, id, introduction, baseline)))
      throw new Error('Candidate disappeared before save.');
  } catch (error) {
    if (error instanceof EditorialConflictError)
      throw new IntroductionError(error.message, 409, introduction, error.currentEditorial);
    console.error('Generated In-depth introduction could not be saved.', error);
    throw new IntroductionError(
      '介绍已生成但保存失败。文本已保留，请使用 Save changes 重试保存，无需重新生成。',
      503,
      introduction,
    );
  }
  return introduction;
}
