import { attachPromptMemory } from './fixtures/prompt-runtime.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ArticleDatabase } from '../src/lib/article-fetch-cache.js';
import {
  createManualInDepthCandidate,
  generateManualInDepthIntroduction,
  ManualCandidateInput,
} from '../src/lib/manual-in-depth.js';
import { IntroductionError } from '../src/lib/in-depth-introduction.js';
import { getPublishedInDepthPage, type InDepthReviewItem } from '../src/lib/in-depth-reads.js';
import { ArticleStore, article, articleUrl, articleText } from './fixtures/article-cache.js';
import { normalizedFetchUrl } from '../src/lib/article-fetch-cache.js';

type Row = InDepthReviewItem & { normalized_url: string; status: string };
type Result = { rows: Record<string, unknown>[]; rowCount?: number };
const humanTags = [{ zh: '科学方法', en: 'Scientific Method' }];
const generated = {
  title_zh: '科学方法论',
  summary: '文章讨论科学方法及论证过程。',
  whyWorthReading: '具有可核查的证据和长期学习价值。',
  extra_info: '原创性和作者可信度需要根据具体证据判断。',
  tags: [{ zh: '方法论', en: 'Methodology' }],
};

/** Committed rows are separate from transaction-local writes; locks serialize creators. */
class ManualStore {
  articles = new ArticleStore();
  rows = new Map<string, Row>();
  prior: Record<string, unknown>[] = [];
  inserts = 0;
  failSave = false;
  failCreate = false;
  generating = new Set<string>();
  async query(sql: string, values: unknown[] = [], rows = this.rows): Promise<Result> {
    if (sql.includes('select name, url from sources')) return { rows: [] };
    if (sql.includes('select idc.id, dc.url'))
      return {
        rows: [...rows.values()]
          .filter((r) => !r.normalized_url || r.normalized_url === values[0] || r.url === values[0])
          .map((r) => ({ id: r.id, url: r.url, normalized_url: r.normalized_url })),
      };
    if (sql.includes('select title, title_zh')) return { rows: this.prior };
    if (sql.includes('select ra.title, pc.title_zh'))
      return {
        rows: this.articles.daily.map((r) => ({
          title: r.title,
          author: r.author,
          publication: r.source_name,
          published_at: r.published_at,
          source_content_id: null,
          evidence: { imageUrl: r.image_url, rawMetadata: r.metadata },
        })),
      };
    if (sql.includes('select dc.*')) {
      const r = rows.get(String(values[0]));
      return {
        rows: r
          ? [
              {
                ...r,
                candidate_id: r.candidateId,
                title: r.originalTitle,
                title_zh: r.titleZh,
                published_at: r.publishedAt,
                source_content_id: null,
                editorial_summary: r.editorialOverrides?.summary,
                editorial_why_worth_reading: r.editorialOverrides?.whyWorthReading,
                editorial_extra_info: r.editorialOverrides?.extra_info,
              },
            ]
          : [],
      };
    }
    if (sql.includes('from in_depth_candidates idc')) {
      const eligible = sql.includes("idc.review_status = 'approved'")
        ? [...rows.values()].filter((r) => r.reviewStatus === 'approved')
        : [rows.get(String(values[0]))].filter((r): r is Row => Boolean(r));
      return { rows: eligible };
    }
    return this.articles.query(sql, values);
  }
  db = attachPromptMemory({
    query: (sql: string, values?: unknown[]) => this.query(sql, values),
    connect: async () => {
      const cache = await this.articles.connect();
      let pending: Map<string, Row> | undefined;
      let candidate: Row | undefined;
      let generationKey: string | undefined;
      const release = () => {
        if (generationKey) this.generating.delete(generationKey);
      };
      const writable = () => (pending ??= structuredClone(this.rows));
      return {
        query: async (sql: string, values: unknown[] = []): Promise<Result> => {
          if (sql.includes('pg_try_advisory_xact_lock')) {
            const key = String(values[0]);
            if (this.generating.has(key)) return { rows: [{ locked: false }] };
            this.generating.add(key);
            generationKey = key;
            return { rows: [{ locked: true }] };
          }
          if (sql === 'commit') {
            await cache.query(sql);
            if (pending) this.rows = pending;
            release();
            return { rows: [] };
          }
          if (sql === 'rollback') {
            pending = undefined;
            release();
            await cache.query(sql);
            return { rows: [] };
          }
          if (
            sql === 'begin' ||
            sql.startsWith('set local') ||
            sql.includes('pg_advisory_xact_lock') ||
            sql.includes('insert into discovery_fetch_cache')
          )
            return cache.query(sql, values);
          if (sql.includes('insert into discovery_candidates')) {
            this.inserts++;
            assert.match(sql, /null, 'manual'/);
            candidate = {
              id: `review-${this.inserts}`,
              candidateId: `candidate-${this.inserts}`,
              runId: null,
              discoveryPath: 'manual',
              reviewStatus: 'pending',
              editorialNotes: null,
              editorialOverrides: null,
              reviewedAt: null,
              createdAt: '2026-10-22T04:00:00Z',
              candidateCreatedAt: '2026-10-22T04:00:00Z',
              url: String(values[0]),
              normalized_url: String(values[1]),
              originalTitle: values[2] as string,
              titleZh: values[3] as string | null,
              author: values[4] as string | null,
              publication: values[5] as string | null,
              contentType: values[6] as string,
              publishedAt: values[7] as string | null,
              summary: values[8] as string | null,
              whyWorthReading: values[9] as string | null,
              evidence: JSON.parse(String(values[10])),
              evaluation: JSON.parse(String(values[11])),
              estimatedDurationMinutes: null,
              extraInfo: {},
              status: 'discovered',
            };
            return { rows: [{ id: candidate.candidateId }], rowCount: 1 };
          }
          if (sql.includes('insert into in_depth_candidates')) {
            if (this.failCreate) throw new Error('Mock review creation failure');
            assert.ok(candidate);
            writable().set(candidate.id, candidate);
            return { rows: [{ id: candidate.id }], rowCount: 1 };
          }
          if (sql.includes('update discovery_candidates')) {
            if (this.failSave) throw new Error('Mock failed save');
            assert.doesNotMatch(sql, /review_status|editorial_notes|decision/);
            const r = [...writable().values()].find((r) => r.candidateId === values[0])!;
            r.titleZh = String(values[1]);
            r.summary = String(values[2]);
            r.whyWorthReading = String(values[3]);
            r.status = 'evaluated';
            r.evaluation = { ...r.evaluation, ...JSON.parse(String(values[4])) };
            assert.match(sql, /evaluation @> '\{"categoryManuallySet":true\}'::jsonb/);
            if (r.evaluation?.categoryManuallySet !== true)
              r.category = (values[5] as Row['category']) ?? r.category ?? null;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('select editorial_summary as summary'))
            return { rows: [{ ...writable().get(String(values[0]))?.editorialOverrides }] };
          if (sql.includes('update in_depth_candidates')) {
            assert.doesNotMatch(sql, /review_status|reviewed_at|editorial_notes/);
            const r = writable().get(String(values[0]))!;
            if (
              [
                r.editorialOverrides?.summary ?? '',
                r.editorialOverrides?.whyWorthReading ?? '',
                r.editorialOverrides?.extra_info ?? '',
              ].some((v, i) => v !== values[i + 4])
            )
              return { rows: [], rowCount: 0 };
            r.editorialOverrides = {
              summary: values[1],
              whyWorthReading: values[2],
              extra_info: values[3],
            };
            return { rows: [{ id: r.id }], rowCount: 1 };
          }
          return this.query(sql, values, pending ?? this.rows);
        },
        release: () => {
          release();
          cache.release();
        },
      };
    },
  } as unknown as ArticleDatabase);
}

let modelCalls = 0;
const request = async (input: { input: unknown; instructions?: string; text?: unknown }) => {
  modelCalls++;
  const body = JSON.parse(String(input.input));
  assert.equal(body.content, articleText);
  assert.equal(normalizedFetchUrl(body.originalUrl), articleUrl);
  assert.match(input.instructions!, /不进行 qualified/);
  assert.doesNotMatch(JSON.stringify(input.text ?? {}), /\\\\p\{/);
  // The concurrency fixture also calls this helper directly, without a provider request.
  if (input.text) {
    const schema = (
      input.text as { format: { schema: { required: string[]; properties: { category: unknown } } } }
    ).format.schema;
    assert.ok(schema.required.includes('category'));
    assert.ok(JSON.stringify(schema.properties.category).includes('null'));
  }
  return {
    id: 'mock',
    output: [],
    output_text: JSON.stringify(generated),
    api_mode: 'chat_completions' as const,
  };
};
const noFetch = async () => {
  throw new Error('Unexpected paid Fetch');
};
const fresh = () => {
  const store = new ManualStore();
  store.articles.seed();
  return store;
};
for (const input of [
  { url: 'file:///etc/passwd' },
  { url: 'https://user:pass@example.test' },
  { url: articleUrl, tags: [{ zh: '科学' }] },
  { url: articleUrl, tags: Array(4).fill(humanTags[0]) },
])
  assert.equal(ManualCandidateInput.safeParse(input).success, false);

const store = fresh();
const first = await createManualInDepthCandidate(
  store.db,
  { url: `${articleUrl}?utm_source=test#top`, tags: humanTags },
  { fetchDocument: noFetch },
);
assert.equal(first.item.discoveryPath, 'manual');
assert.equal(first.item.runId, null);
assert.equal(first.item.reviewStatus, 'pending');
assert.equal(modelCalls, 0);
assert.equal(store.rows.get(first.item.id)?.status, 'discovered');
// Approved duplicates keep all existing content and status; submitted Tags do not overwrite it.
store.rows.get(first.item.id)!.reviewStatus = 'approved';
store.rows.get(first.item.id)!.editorialNotes = 'Preserve notes';
const before = structuredClone(store.rows.get(first.item.id));
const duplicate = await createManualInDepthCandidate(
  store.db,
  { url: articleUrl, tags: generated.tags },
  { fetchDocument: noFetch },
);
assert.equal(duplicate.existing, true);
assert.deepEqual(store.rows.get(first.item.id), before);
// Historical records without normalized_url still match normalized tracking URLs.
store.rows.get(first.item.id)!.normalized_url = '';
assert.equal(
  (await createManualInDepthCandidate(store.db, { url: articleUrl }, { fetchDocument: noFetch }))
    .existing,
  true,
);
store.rows.get(first.item.id)!.normalized_url = articleUrl;

const simultaneous = fresh();
const results = await Promise.all(
  [1, 2].map(() =>
    createManualInDepthCandidate(simultaneous.db, { url: articleUrl }, { fetchDocument: noFetch }),
  ),
);
assert.equal(simultaneous.rows.size, 1);
assert.equal(simultaneous.inserts, 1);
assert.equal(results.filter((r) => r.existing).length, 1);

const fetched = new ManualStore();
let fetches = 0;
await createManualInDepthCandidate(
  fetched.db,
  { url: articleUrl },
  {
    fetchDocument: async () => {
      fetches++;
      return article();
    },
  },
);
await generateManualInDepthIntroduction(fetched.db, 'review-1', { request });
assert.equal(fetches, 1);
assert.equal(fetched.rows.get('review-1')!.titleZh, generated.title_zh);
for (const manualCategory of [undefined, 'history', null] as const) {
  const row = fetched.rows.get('review-1')!;
  row.category = manualCategory ?? null;
  row.evaluation = { ...row.evaluation, categoryManuallySet: manualCategory !== undefined };
  await generateManualInDepthIntroduction(fetched.db, 'review-1', {
    regenerate: true,
    request: async () => ({
      id: 'category-test',
      output: [],
      api_mode: 'chat_completions',
      output_text: JSON.stringify({ ...generated, category: 'technology' }),
    }),
  });
  assert.equal(
    fetched.rows.get('review-1')?.category,
    manualCategory === undefined ? 'technology' : manualCategory,
  );
}
const protectedRow = fetched.rows.get('review-1')!;
protectedRow.category = 'business';
protectedRow.evaluation = { ...protectedRow.evaluation, categoryManuallySet: false };
await generateManualInDepthIntroduction(fetched.db, 'review-1', { request, regenerate: true });
assert.equal(
  fetched.rows.get('review-1')?.category,
  'business',
  'Legacy output omission must not clear existing Category.',
);
await generateManualInDepthIntroduction(fetched.db, 'review-1', {
  regenerate: true,
  request: async () => {
    const current = fetched.rows.get('review-1')!;
    current.category = null;
    current.evaluation = { ...current.evaluation, categoryManuallySet: true };
    return {
      id: 'concurrent-category',
      output: [],
      api_mode: 'chat_completions',
      output_text: JSON.stringify({ ...generated, category: 'history' }),
    };
  },
});
assert.equal(
  fetched.rows.get('review-1')?.category,
  null,
  'Human clear while LLM is running wins.',
);
const priorCallsAfterCategory = modelCalls;
await generateManualInDepthIntroduction(fetched.db, 'review-1', { request });
assert.equal(
  modelCalls,
  priorCallsAfterCategory,
  'Completed Generate is reused without charging again',
);
await generateManualInDepthIntroduction(fetched.db, 'review-1', { request, regenerate: true });
assert.equal(modelCalls, priorCallsAfterCategory + 1);

await generateManualInDepthIntroduction(store.db, first.item.id, { request });
assert.deepEqual(store.rows.get(first.item.id)?.evaluation?.tags, [
  ...humanTags,
  ...generated.tags,
]);
assert.equal(store.rows.get(first.item.id)?.evaluation?.decision, undefined);
assert.equal(store.rows.get(first.item.id)?.reviewStatus, 'approved');
assert.equal(store.rows.get(first.item.id)?.editorialNotes, 'Preserve notes');
assert.equal((await getPublishedInDepthPage(store.db)).items.length, 1);
assert.equal((await getPublishedInDepthPage(fetched.db)).items.length, 0);
assert.equal(
  (await getPublishedInDepthPage(store.db)).items[0]?.editorial.summary,
  generated.summary,
);

const supplementalTags = [
  { zh: '人工智能', en: 'Artificial Intelligence' },
  { zh: '科学研究', en: 'Scientific Research' },
];
for (const manualTags of [
  [],
  humanTags,
  [...humanTags, supplementalTags[0]!],
  [...humanTags, ...supplementalTags],
]) {
  const target = fresh();
  const created = await createManualInDepthCandidate(
    target.db,
    { url: articleUrl, tags: manualTags },
    { fetchDocument: noFetch },
  );
  await generateManualInDepthIntroduction(target.db, created.item.id, {
    request: async () => ({
      id: 'mock-tags',
      output: [],
      api_mode: 'chat_completions' as const,
      output_text: JSON.stringify({
        ...generated,
        tags: [
          { zh: '科学方法', en: 'SCIENTIFIC METHOD' },
          ...generated.tags,
          supplementalTags[1]!,
        ],
      }),
    }),
  });
  const expected =
    manualTags.length === 0
      ? [{ zh: '科学方法', en: 'SCIENTIFIC METHOD' }, ...generated.tags, supplementalTags[1]!]
      : [...manualTags, ...generated.tags, supplementalTags[1]!].slice(0, 3);
  assert.deepEqual(target.rows.get(created.item.id)?.evaluation?.tags, expected);
  await generateManualInDepthIntroduction(target.db, created.item.id, {
    request,
    regenerate: true,
  });
  assert.deepEqual(
    target.rows.get(created.item.id)?.evaluation?.tags,
    manualTags.length ? expected : generated.tags,
    'Regenerate retains human tags and previously filled slots',
  );
}

for (const doc of [
  article({ status: 'error', markdown: '', isComplete: false, error: 'blocked' }),
  article({ isComplete: false }),
]) {
  const failed = new ManualStore();
  await assert.rejects(
    createManualInDepthCandidate(
      failed.db,
      { url: articleUrl },
      { fetchDocument: async () => doc },
    ),
    (e) => e instanceof IntroductionError && e.status === 422,
  );
  assert.equal(failed.rows.size, 0);
}
const daily = new ManualStore();
daily.articles.daily = [
  {
    url: articleUrl,
    full_content_text: articleText,
    title: 'Daily original',
    author: 'Daily author',
    published_at: '2026-10-01T10:00:00Z',
    collected_at: '2026-10-22T10:00:00Z',
    source_name: 'Daily publisher',
    image_url: null,
  },
];
const dailyItem = await createManualInDepthCandidate(
  daily.db,
  { url: articleUrl },
  { fetchDocument: noFetch },
);
assert.equal(dailyItem.item.originalTitle, 'Daily original');
assert.equal(dailyItem.item.author, 'Daily author');
await generateManualInDepthIntroduction(daily.db, dailyItem.item.id, { request });

const legacy = new ManualStore();
legacy.prior = [
  {
    title: 'Discovery original',
    title_zh: '已有中文标题',
    author: 'Discovery author',
    publication: 'Discovery publisher',
    content_type: 'article',
    summary: '已有概要',
    why_worth_reading: '已有价值',
    evaluation: { tags: humanTags },
    evidence: {
      fetch: {
        status: 'success',
        truncated: false,
        contentComplete: true,
        contentType: 'article_body',
        content: articleText,
      },
    },
  },
];
const legacyItem = await createManualInDepthCandidate(
  legacy.db,
  { url: articleUrl },
  { fetchDocument: noFetch },
);
assert.equal(legacyItem.item.originalTitle, 'Discovery original');
assert.equal(legacyItem.item.author, 'Discovery author');
assert.equal(
  legacy.articles.cache.size,
  1,
  'Legacy Discovery full body is cached before creating a reference',
);
assert.equal((legacyItem.item.evidence?.fetch as Record<string, unknown>).content, undefined);
await generateManualInDepthIntroduction(legacy.db, legacyItem.item.id, { request });

const createFailure = new ManualStore();
createFailure.failCreate = true;
await assert.rejects(
  createManualInDepthCandidate(
    createFailure.db,
    { url: articleUrl },
    {
      fetchDocument: async () => article(),
    },
  ),
);
assert.equal(
  createFailure.rows.size,
  0,
  'A failed review insert rolls back its metadata transaction',
);
assert.equal(
  createFailure.articles.cache.size,
  1,
  'Successful paid Fetch remains reusable after creation failure',
);
createFailure.failCreate = false;
await createManualInDepthCandidate(
  createFailure.db,
  { url: articleUrl },
  { fetchDocument: noFetch },
);

const cacheFailure = new ManualStore();
cacheFailure.articles.failWrite = true;
await assert.rejects(
  createManualInDepthCandidate(
    cacheFailure.db,
    { url: articleUrl },
    {
      fetchDocument: async () => article(),
    },
  ),
  (e) => e instanceof IntroductionError && e.status === 503,
);
assert.equal(
  cacheFailure.rows.size,
  0,
  'Cannot create a dangling reference after cache save failure',
);

const invalid = fresh();
const invalidItem = await createManualInDepthCandidate(invalid.db, { url: articleUrl });
await assert.rejects(
  generateManualInDepthIntroduction(invalid.db, invalidItem.item.id, {
    request: async () => {
      throw new Error('Mock LLM failure');
    },
  }),
  (e) => e instanceof IntroductionError && e.status === 502,
);
assert.equal(invalid.rows.get(invalidItem.item.id)?.editorialOverrides, null);
invalid.articles.cache.clear();
const missingCalls = modelCalls;
await assert.rejects(
  generateManualInDepthIntroduction(invalid.db, invalidItem.item.id, { request }),
  (e) => e instanceof IntroductionError && e.status === 422,
);
assert.equal(modelCalls, missingCalls);

const saveFailure = fresh();
await createManualInDepthCandidate(saveFailure.db, { url: articleUrl });
saveFailure.failSave = true;
await assert.rejects(
  generateManualInDepthIntroduction(saveFailure.db, 'review-1', { request }),
  (e) =>
    e instanceof IntroductionError &&
    e.status === 503 &&
    e.introduction?.summary === generated.summary,
);
assert.equal(saveFailure.rows.get('review-1')?.titleZh, null);
assert.equal(saveFailure.rows.get('review-1')?.reviewStatus, 'pending');

const busy = fresh();
await createManualInDepthCandidate(busy.db, { url: articleUrl });
let resolveModel!: (value: Awaited<ReturnType<typeof request>>) => void;
let started!: () => void;
const hasStarted = new Promise<void>((resolve) => {
  started = resolve;
});
const pending = generateManualInDepthIntroduction(busy.db, 'review-1', {
  request: async () => {
    started();
    return new Promise((resolve) => {
      resolveModel = resolve;
    });
  },
});
await hasStarted;
await assert.rejects(
  generateManualInDepthIntroduction(busy.db, 'review-1', { request }),
  (e) => e instanceof IntroductionError && e.status === 409,
);
resolveModel(
  await request({
    input: JSON.stringify({ originalUrl: articleUrl, content: articleText }),
    instructions: '不进行 qualified',
  }),
);
await pending;

const migration = await readFile(
  new URL('../drizzle/0019_manual_in_depth.sql', import.meta.url),
  'utf8',
);
assert.match(migration, /discovery_path <> 'manual' AND run_id IS NOT NULL/);
assert.match(migration, /discovery_path = 'manual' AND run_id IS NULL/);
assert.doesNotMatch(migration, /INSERT INTO.*discovery_runs|DELETE FROM|DROP TABLE/i);
const directVerification = await readFile(
  new URL('../src/discovery/direct-verification.ts', import.meta.url),
  'utf8',
);
assert.match(
  directVerification,
  /where run_id is distinct from \$1::uuid/,
  'D4 history must include manual candidates with NULL Run IDs',
);
console.log(
  'Manual candidate creation, normalized/legacy duplicates, concurrency, Cache/Daily reuse, Generate/Regenerate, tags, atomic failures and publication boundary passed.',
);

const concurrentEditorial = fresh();
const concurrentItem = await createManualInDepthCandidate(
  concurrentEditorial.db,
  { url: articleUrl },
  { fetchDocument: noFetch },
);
const humanEditorial = {
  summary: '人工保存的介绍',
  whyWorthReading: '人工理由',
  extra_info: '人工评价',
};
const oldCandidate = structuredClone(concurrentEditorial.rows.get(concurrentItem.item.id)!);
await assert.rejects(
  generateManualInDepthIntroduction(concurrentEditorial.db, concurrentItem.item.id, {
    request: async (input) => {
      concurrentEditorial.rows.get(concurrentItem.item.id)!.editorialOverrides = humanEditorial;
      return request(input);
    },
  }),
  (error: unknown) =>
    error instanceof IntroductionError &&
    error.status === 409 &&
    Boolean(error.introduction) &&
    error.currentEditorial?.summary === humanEditorial.summary,
);
assert.deepEqual(
  concurrentEditorial.rows.get(concurrentItem.item.id)!.editorialOverrides,
  humanEditorial,
);
assert.equal(
  concurrentEditorial.rows.get(concurrentItem.item.id)!.titleZh,
  oldCandidate.titleZh,
  'Conflict rolls back Candidate metadata updates with the Editorial write.',
);
assert.equal(
  concurrentEditorial.rows.get(concurrentItem.item.id)!.reviewStatus,
  oldCandidate.reviewStatus,
);
assert.equal(
  concurrentEditorial.rows.get(concurrentItem.item.id)!.editorialNotes,
  oldCandidate.editorialNotes,
);
console.log(
  'Manual Generate optimistic conflict preserves Editorial and atomically rolls back metadata.',
);
