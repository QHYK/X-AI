import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { generateReadMoreSummary } from '../src/lib/read-more.js';
import {
  READ_MORE_CONTENT_TEXT_MIN_LENGTH,
  readMoreTextLength,
  selectReadMoreSourceText,
  type ReadMoreContent,
} from '../src/lib/read-more-eligibility.js';

assert.equal(READ_MORE_CONTENT_TEXT_MIN_LENGTH, 3000, 'Formal Spec boundary must not drift');
assert.equal(readMoreTextLength('😀'), 1, 'Count code points, not UTF-16 code units');
const whitespace =
  '\t\n\r\v\f \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const cases: Array<{ name: string; row: ReadMoreContent; expected: string | null }> = [
  { name: 'No text', row: { fullContentText: null, contentText: null }, expected: null },
  {
    name: 'Whitespace only',
    row: { fullContentText: whitespace, contentText: whitespace },
    expected: null,
  },
  {
    name: 'Full text has priority without a length floor',
    row: { fullContentText: `${whitespace}full${whitespace}`, contentText: '甲'.repeat(3001) },
    expected: 'full',
  },
  {
    name: '2999 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(2999) },
    expected: null,
  },
  {
    name: '3000 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(3000) },
    expected: '甲'.repeat(3000),
  },
  {
    name: '3001 partial characters',
    row: { fullContentText: '', contentText: '甲'.repeat(3001) },
    expected: '甲'.repeat(3001),
  },
  {
    name: 'Previously rejected 3999 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(3999) },
    expected: '甲'.repeat(3999),
  },
  {
    name: 'Trim before measuring, not after',
    row: {
      fullContentText: whitespace,
      contentText: `${whitespace}${'甲'.repeat(2999)}${whitespace}`,
    },
    expected: null,
  },
  {
    name: 'Whitespace full text falls back to usable partial text',
    row: {
      fullContentText: whitespace,
      contentText: `${whitespace}${'甲'.repeat(3000)}${whitespace}`,
    },
    expected: '甲'.repeat(3000),
  },
  {
    name: '2999 astral Unicode code points',
    row: { fullContentText: null, contentText: '😀'.repeat(2999) },
    expected: null,
  },
  {
    name: '3000 astral Unicode code points',
    row: { fullContentText: null, contentText: '😀'.repeat(3000) },
    expected: '😀'.repeat(3000),
  },
];
for (const { name, row, expected } of cases) {
  assert.equal(selectReadMoreSourceText(row), expected, name);
  let generationCalls = 0;
  const queries: string[] = [];
  const db = {
    query: async (text: string, values?: unknown[]) => {
      queries.push(text);
      if (text.includes('select summary_zh')) return { rows: [{ summaryZh: whitespace }] };
      if (text.includes('from processed_contents')) return { rows: [row] };
      assert.ok(text.includes('on conflict (content_id) do update'));
      assert.equal(values?.[1], 'Generated guide');
      return { rows: [{ summaryZh: 'Generated guide' }] };
    },
  } as unknown as Pool;
  const result = await generateReadMoreSummary(db, '00000000-0000-4000-8000-000000000001', {
    generate: async (source) => {
      generationCalls++;
      assert.equal(source, expected, name);
      return 'Generated guide';
    },
  });
  assert.deepEqual(
    result,
    expected === null
      ? { status: 'not_available' }
      : { status: 'success', summary_zh: 'Generated guide' },
    name,
  );
  assert.equal(generationCalls, expected === null ? 0 : 1, name);
  assert.equal(queries.length, expected === null ? 2 : 3, name);
}
// Persisted output stays readable even if the current source is missing/shortened.
const cachedDb = {
  query: async (text: string) => {
    assert.ok(text.includes('select summary_zh'), 'Cache hit must not query source or write');
    return { rows: [{ summaryZh: ' cached ' }] };
  },
} as unknown as Pool;
assert.deepEqual(
  await generateReadMoreSummary(cachedDb, '00000000-0000-4000-8000-000000000001', {
    generate: async () => {
      throw new Error('Cache hit must not call LLM');
    },
  }),
  { status: 'success', summary_zh: 'cached' },
);
const missingDb = { query: async () => ({ rows: [] }) } as unknown as Pool;
assert.deepEqual(await generateReadMoreSummary(missingDb, '00000000-0000-4000-8000-000000000001'), {
  status: 'not_available',
});
console.log(
  'Read More: Spec 3000 boundary, Unicode, whitespace, source priority, partial text, cache and unavailable paths passed.',
);
