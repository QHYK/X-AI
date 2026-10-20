import assert from 'node:assert/strict';
import {
  generateAndSaveInDepthIntroduction,
  IntroductionError,
} from '../src/lib/in-depth-introduction.js';
import { ArticleStore, article, articleUrl, articleText } from './fixtures/article-cache.js';

const id = '00000000-0000-4000-8000-000000000001';
const introduction = {
  summary: '## 核心问题\n文章的重要论证和结论。',
  whyWorthReading: '对科学方法的深入解释，适合主动学习的读者。',
  extra_info: '作者提供了可核查的证据，原创性与人类创作特征无法仅凭来源确定。',
};
let modelCalls = 0;
let fetches = 0;
const goodRequest = async (request: {
  input: unknown;
  instructions?: string;
  tools?: unknown;
  text?: unknown;
}) => {
  modelCalls++;
  const input = JSON.parse(String(request.input));
  assert.equal(input.originalUrl, articleUrl);
  assert.equal(input.content, articleText);
  assert.equal(input.contentComplete, true);
  assert.match(request.instructions ?? '', /X-field.*内容研究编辑/);
  assert.equal(
    request.tools,
    undefined,
    'Plain Structured Chat receives actual text, not an assumed web-reading tool.',
  );
  return {
    id: 'mock',
    output: [],
    output_text: JSON.stringify(introduction),
    api_mode: 'chat_completions' as const,
  };
};
const noFetch = async () => {
  fetches++;
  throw new Error('No repeated Fetch allowed.');
};
const providerEnvironment = [
  'DISCOVERY_LLM_PROVIDER',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'CODEX_MODEL',
  'KIMI_MODEL',
  'DISCOVERY_D4_PROVIDER',
] as const;
const savedEnvironment = providerEnvironment.map((key) => [key, process.env[key]] as const);
try {
  process.env.DISCOVERY_LLM_PROVIDER = ' codex ';
  process.env.LLM_PROVIDER = 'kimi';
  process.env.LLM_MODEL = 'wrong-generic-model';
  process.env.CODEX_MODEL = 'discovery-editorial-model';
  process.env.KIMI_MODEL = 'fallback-editorial-model';
  process.env.DISCOVERY_D4_PROVIDER = 'deepseek';
  const providerStore = new ArticleStore();
  providerStore.seed();
  await generateAndSaveInDepthIntroduction(providerStore.db, id, {
    request: async (request) => {
      assert.equal(request.model, 'discovery-editorial-model');
      return goodRequest(request);
    },
    fetchDocument: noFetch,
  });
  delete process.env.DISCOVERY_LLM_PROVIDER;
  await generateAndSaveInDepthIntroduction(providerStore.db, id, {
    request: async (request) => {
      assert.equal(request.model, 'fallback-editorial-model');
      return goodRequest(request);
    },
    fetchDocument: noFetch,
  });
} finally {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
for (const path of ['topic', 'direct', 'open']) {
  const store = new ArticleStore();
  if (path === 'direct') {
    store.source!.source_content_id = '00000000-0000-4000-8000-000000000009';
    store.daily.push({
      url: 'https://example.test/canonical-daily',
      full_content_text: articleText,
      title: 'Daily',
      author: 'Author',
      collected_at: '2026-10-19T00:00:00Z',
      source_name: 'Daily source',
      source_content_id: store.source!.source_content_id,
    });
  } else store.seed();
  const original = JSON.stringify(store.source);
  assert.deepEqual(
    await generateAndSaveInDepthIntroduction(store.db, id, {
      request: goodRequest,
      fetchDocument: noFetch,
    }),
    introduction,
  );
  assert.equal(store.editorial?.extra_info, introduction.extra_info);
  assert.equal(JSON.stringify(store.source), original);
}
assert.equal(fetches, 0);
const fresh = new ArticleStore();
const fetchArticle = async (url: string) => {
  assert.equal(url, articleUrl);
  fetches++;
  return article();
};
await generateAndSaveInDepthIntroduction(fresh.db, id, {
  request: goodRequest,
  fetchDocument: fetchArticle,
});
assert.equal(fetches, 1);
assert.deepEqual(
  fresh.writes,
  ['cache', 'editorial'],
  'The paid article commits before the model result is saved.',
);
await generateAndSaveInDepthIntroduction(fresh.db, id, {
  request: goodRequest,
  fetchDocument: fetchArticle,
});
assert.equal(fetches, 1, 'Regenerate uses the saved full original.');
const legacy = new ArticleStore();
legacy.source!.evidence = {
  fetch: {
    status: 'success',
    content: articleText,
    contentComplete: true,
    truncated: false,
    contentType: 'article_body',
  },
};
await generateAndSaveInDepthIntroduction(legacy.db, id, {
  request: goodRequest,
  fetchDocument: noFetch,
});
const unavailable = new ArticleStore();
const beforeCalls = modelCalls;
await assert.rejects(
  generateAndSaveInDepthIntroduction(unavailable.db, id, {
    request: goodRequest,
    fetchDocument: async () =>
      article({ status: 'error', markdown: '', isComplete: false, error: 'Unavailable' }),
  }),
  (error) => error instanceof IntroductionError && error.status === 422,
);
await assert.rejects(
  generateAndSaveInDepthIntroduction(unavailable.db, id, {
    request: goodRequest,
    fetchDocument: async () => article({ isComplete: false }),
  }),
  (error) => error instanceof IntroductionError && error.status === 422,
);
assert.equal(modelCalls, beforeCalls);
const tooLong = new ArticleStore();
tooLong.seed(article({ markdown: articleText.repeat(100) }));
await assert.rejects(
  generateAndSaveInDepthIntroduction(tooLong.db, id, {
    request: goodRequest,
    fetchDocument: noFetch,
  }),
  (error) => error instanceof IntroductionError && error.status === 422,
);
assert.equal(modelCalls, beforeCalls);
const failedSave = new ArticleStore();
failedSave.seed();
failedSave.failEditorial = true;
await assert.rejects(
  generateAndSaveInDepthIntroduction(failedSave.db, id, {
    request: goodRequest,
    fetchDocument: noFetch,
  }),
  (error) =>
    error instanceof IntroductionError &&
    error.status === 503 &&
    error.introduction?.extra_info === introduction.extra_info,
);
for (const invalid of [
  { summary: '', whyWorthReading: '', extra_info: '原文证据不足，无法确认核心论证。' },
  { summary: '中文摘要', whyWorthReading: '中文理由' },
  { ...introduction, extra_info: {} },
  { ...introduction, evidenceSufficient: true },
]) {
  const store = new ArticleStore();
  store.seed();
  await assert.rejects(
    generateAndSaveInDepthIntroduction(store.db, id, {
      fetchDocument: noFetch,
      request: async () => ({
        id: 'mock',
        output: [],
        output_text: JSON.stringify(invalid),
        api_mode: 'chat_completions',
      }),
    }),
  );
  assert.equal(store.editorial, null);
}
const modelFail = new ArticleStore();
await assert.rejects(
  generateAndSaveInDepthIntroduction(modelFail.db, id, {
    fetchDocument: fetchArticle,
    request: async () => {
      throw new Error('Mock model failure');
    },
  }),
  (error) => error instanceof IntroductionError && error.status === 502,
);
assert.equal(modelFail.cache.size, 1, 'A failed model call must not lose already-paid content.');
await generateAndSaveInDepthIntroduction(modelFail.db, id, {
  request: goodRequest,
  fetchDocument: noFetch,
});
console.log(
  'Editorial fixed-URL reading, three-path reuse, no repeat Fetch, three-field validation, auto-save and recoverable failures passed.',
);

// Exercise the actual anonymous HTTP handler with an isolated database-module loader.
const { register } = await import('node:module');
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (/\\/src\\/db\\/index\\.[jt]s$/.test(url)) return { format:'module', source:'export function getDatabasePool() { return globalThis.__inDepthPublicTestDb; }', shortCircuit:true };
  return nextLoad(url, context);
}`)}`,
  import.meta.url,
);
const publicRows = ['approved', 'pending', 'rejected'].map((reviewStatus, index) => ({
  id: String(index),
  reviewStatus,
  url: 'https://example.test/work',
  discoveryPath: 'direct',
  originalTitle: 'Original',
  titleZh: '中文标题',
  author: 'Author',
  publication: 'Example',
  contentType: 'article',
  estimatedDurationMinutes: 15,
  summary: 'Agent summary',
  whyWorthReading: 'Agent reason',
  editorialOverrides: introduction,
  reviewedAt: null,
  editorialNotes: 'Private notes',
  evidence: { private: true },
  evaluation: { private: true },
}));
Object.assign(globalThis, {
  __inDepthPublicTestDb: {
    async query(sql: string) {
      if (sql.includes('select name, url from sources')) return { rows: [] };
      assert.ok(sql.includes("where idc.review_status = 'approved'"));
      assert.ok(!sql.includes('editorial_notes'));
      return { rows: publicRows.filter((row) => row.reviewStatus === 'approved') };
    },
  },
});
const { GET: publicGet } = await import('../src/app/api/in-depth/route.js');
const response = await publicGet();
assert.equal(response.status, 200);
assert.equal(response.headers.get('Cache-Control'), 'no-store');
const payload = await response.json();
assert.equal(payload.items.length, 1);
assert.equal(payload.items[0].summary, introduction.summary);
assert.equal(payload.items[0].extra_info, introduction.extra_info);
for (const field of [
  'editorialNotes',
  'editorialOverrides',
  'evidence',
  'evaluation',
  'reviewStatus',
])
  assert.equal(field in payload.items[0], false);
publicRows[0]!.editorialOverrides = {
  summary: '已上架后的更新',
  whyWorthReading: '更新价值',
  extra_info: '更新的具体评估',
};
assert.equal((await (await publicGet()).json()).items[0].summary, '已上架后的更新');
publicRows[0]!.editorialOverrides = { summary: '', whyWorthReading: '', extra_info: '' };
assert.equal((await (await publicGet()).json()).items[0].summary, 'Summary');
assert.equal((await (await publicGet()).json()).items[0].extra_info, '');
console.log(
  'Anonymous public API: approval boundary, immediate Editorial updates, legacy fallback and private-field exclusion passed.',
);
