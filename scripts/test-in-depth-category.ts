import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  IN_DEPTH_CATEGORIES,
  InDepthCategorySchema,
  parseAiCategory,
  IN_DEPTH_CATEGORY_LABELS,
} from '../src/lib/in-depth-category.js';
import {
  DiscoveryD3OutputSchema,
  validateDiscoveryD3Output,
} from '../src/discovery/topic-discovery.js';
import {
  DiscoveryD5OutputSchema,
  validateDiscoveryD5Output,
} from '../src/discovery/open-discovery.js';
import {
  discoveryD4OutputJsonSchema,
  parseAndValidateDiscoveryD4Output,
} from '../src/discovery/direct-verification.js';
import { ManualOutputSchema } from '../src/lib/manual-in-depth.js';
import {
  parseInDepthReviewUpdate,
  updateInDepthReviewItem,
  toPublicInDepthRead,
  type PublishedInDepthRead,
} from '../src/lib/in-depth-reads.js';
import type { Pool } from 'pg';

const candidate = {
  url: 'https://example.test/work',
  title: 'Work',
  title_zh: '作品标题',
  author: 'Author',
  contentType: 'article',
  publishedAt: null,
  estimatedDurationMinutes: 10,
  summary: '作品摘要',
  whyWorthReading: '推荐理由',
  evidence: '具体依据',
  limitations: '',
  tags: [],
  extra_info: '{}',
};
const lead = {
  leadId: 'lead-1',
  kind: 'topic' as const,
  question: 'Question',
  rationale: 'Reason',
  newsContext: 'News',
  sourceContentIds: [],
};
const d4 = {
  candidateId: 'candidate-1',
  decision: 'qualified',
  reason: 'Reason',
  title_zh: '作品标题',
  summary: '作品摘要',
  whyWorthReading: '推荐理由',
  evidence: [],
  limitations: [],
  tags: [],
  extra_info: '{}',
};
const manual = {
  title_zh: '作品标题',
  summary: '作品摘要',
  whyWorthReading: '推荐理由',
  extra_info: '具体评估',
  tags: [],
};
const id = '00000000-0000-4000-8000-000000000001';
const parseD3 = (category: Record<string, unknown>) =>
  validateDiscoveryD3Output(
    { candidates: [{ ...candidate, sourceLeadId: lead.leadId, ...category }] },
    [lead],
  )[0]!;
const parseD5 = (category: Record<string, unknown>) =>
  validateDiscoveryD5Output({
    candidates: [{ ...candidate, publication: 'Source', ...category }],
  })[0]!;
const parseD4 = (category: Record<string, unknown>) =>
  parseAndValidateDiscoveryD4Output(JSON.stringify({ evaluations: [{ ...d4, ...category }] }), [
    'candidate-1',
  ])[0]!;

for (const category of IN_DEPTH_CATEGORIES) {
  assert.equal(InDepthCategorySchema.parse(category), category);
  assert.equal(parseD3({ category }).category, category);
  assert.equal(parseD5({ category }).category, category);
  assert.equal(parseD4({ category }).category, category);
  assert.equal(ManualOutputSchema.parse({ ...manual, category }).category, category);
  assert.equal(parseInDepthReviewUpdate({ id, action: 'category', category }).action, 'category');
  const work = { category, editorialOverrides: null } as PublishedInDepthRead;
  assert.equal(toPublicInDepthRead(work).categoryLabel, IN_DEPTH_CATEGORY_LABELS[category]);
}
for (const value of [{}, { category: null }]) {
  assert.equal(parseD3(value).category, null);
  assert.equal(parseD5(value).category, null);
  assert.equal(parseD4(value).category, null);
  assert.equal(parseAiCategory(ManualOutputSchema.parse({ ...manual, ...value }).category), null);
}
for (const category of ['science', 'Technology', '', 1, [], {}, ['technology', 'history']]) {
  assert.throws(() => parseD3({ category }));
  assert.throws(() => parseD5({ category }));
  assert.throws(() => parseD4({ category }));
  assert.throws(() => ManualOutputSchema.parse({ ...manual, category }));
  assert.throws(() => parseInDepthReviewUpdate({ id, action: 'category', category }));
}
assert.throws(() => parseInDepthReviewUpdate({ id, action: 'category' }));
assert.throws(() =>
  parseInDepthReviewUpdate({ id, action: 'category', category: null, reviewStatus: 'approved' }),
);
assert.equal(
  toPublicInDepthRead({ editorialOverrides: null } as PublishedInDepthRead).category,
  null,
);
assert.equal(
  toPublicInDepthRead({ editorialOverrides: null } as PublishedInDepthRead).categoryLabel,
  null,
);
for (const category of [...IN_DEPTH_CATEGORIES, null]) {
  let statement = '';
  const db = {
    async query(sql: string, values: unknown[]) {
      statement = sql;
      assert.deepEqual(values, [id, category]);
      return { rows: [] };
    },
  } as unknown as Pick<Pool, 'query'>;
  await updateInDepthReviewItem(db, { id, action: 'category', category });
  assert.match(statement, /update discovery_candidates dc/);
  assert.match(statement, /categoryManuallySet/);
  assert.doesNotMatch(statement, /set review_status|editorial_summary|editorial_notes|"tags"/);
}
// Exercise the actual SDK schema conversion, including its strict required/nullable lowering.
for (const schema of [DiscoveryD3OutputSchema, DiscoveryD5OutputSchema]) {
  const sent = zodTextFormat(schema, 'output').schema as unknown as {
    properties: {
      candidates: { items: { required: string[]; properties: { category: unknown } } };
    };
  };
  const entry = sent.properties.candidates.items;
  assert.ok(entry.required.includes('category'));
  assert.ok(JSON.stringify(entry.properties.category).includes('null'));
}
const d4Sent = discoveryD4OutputJsonSchema.properties.evaluations.items;
assert.ok(d4Sent.required.includes('category'));
assert.deepEqual(d4Sent.properties.category.enum, [...IN_DEPTH_CATEGORIES, null]);
const migration = await readFile(
  new URL('../drizzle/0027_in_depth_category.sql', import.meta.url),
  'utf8',
);
for (const category of IN_DEPTH_CATEGORIES) assert.ok(migration.includes(`'${category}'`));
assert.match(migration, /CHECK \("category" IS NULL OR/);
assert.doesNotMatch(migration, /UPDATE|in_depth_candidates|NOT NULL/);
console.log(
  'Seven Category values, four output parsers, strict SDK schema, legacy omission/null, independent Review action and public labels passed.',
);
