import assert from 'node:assert/strict';
import { readMoreAvailabilitySql } from '../src/lib/read-more-eligibility.js';
import type { Pool } from 'pg';
import { getDailyBriefForDailyDate } from '../src/lib/daily-brief.js';

const queries: string[] = [];
const pool = {
  query: async (text: string) => {
    queries.push(text);
    if (text.includes("pc.routing = 'digest'"))
      return {
        rows: [
          {
            id: 'digest-1',
            rank: 1,
            title: 'Digest',
            title_zh: null,
            summary: null,
            summary_zh: null,
            category: 'Technology',
            source: 'Source',
            url: null,
            published_at: null,
            created_at: '2026-10-10T00:00:00.000Z',
            hasFullContent: true,
          },
        ],
      };
    if (text.includes("pc.routing = 'long_form'"))
      return {
        rows: [
          {
            id: 'long-1',
            rank: 1,
            title: 'Long',
            title_zh: null,
            summary: null,
            summary_zh: null,
            category: 'General',
            source: 'Source',
            url: null,
            published_at: null,
            created_at: '2026-10-10T00:00:00.000Z',
            hasFullContent: false,
          },
        ],
      };
    return { rows: [] };
  },
} as Pool;

const brief = await getDailyBriefForDailyDate(pool, '2026-10-10');
const contentQueries = queries.filter((query) => query.includes('content_read_more'));
const passed =
  brief.digests.Technology?.[0]?.has_full_content === true &&
  brief.long_form[0]?.has_full_content === false &&
  !('read_more_available' in (brief.digests.Technology?.[0] ?? {})) &&
  contentQueries.length === 2 &&
  contentQueries.every(
    (query) => query.includes(readMoreAvailabilitySql()) && query.includes(') >= 3000'),
  ) &&
  contentQueries.every(
    (query) => query.includes('as "hasFullContent"') && !query.includes('readMoreAvailable'),
  ) &&
  contentQueries.every((query) => !query.includes('ra.content_text as'));

// SQL uses the same boundary for both channels and explicit JS-trim whitespace, not default btrim.
const predicate = readMoreAvailabilitySql();
assert.equal(
  (predicate.match(/U&'/g) ?? []).length,
  3,
  'Trim cache, full text and partial text identically',
);
const encodedSet = /U&'([^']+)'/.exec(predicate)![1];
const trimCharacters = encodedSet.replace(/\\([a-f0-9]{4})/g, (_, hex: string) =>
  String.fromCodePoint(parseInt(hex, 16)),
);
for (const char of trimCharacters)
  assert.equal(char.trim(), '', `SQL removes only JS edge whitespace: ${JSON.stringify(char)}`);
for (const char of [
  '\t',
  '\n',
  '\r',
  ' ',
  '\u00a0',
  '\u2003',
  '\u2028',
  '\u2029',
  '\u3000',
  '\ufeff',
])
  assert.ok(trimCharacters.includes(char), `SQL must trim ${JSON.stringify(char)}`);
assert.ok(!trimCharacters.includes('\u200b'), 'Zero-width space is content in both JS and SQL');
assert.ok(!contentQueries.some((query) => query.includes('>= 4000')));
assert.ok(
  predicate.includes('crm.summary_zh') &&
    predicate.includes('ra.full_content_text') &&
    predicate.includes('char_length('),
);
assert.ok(
  passed,
  'Both actual Brief queries must use the shared eligibility expression without leaking article content',
);

console.log(JSON.stringify({ success: passed, contentQueryCount: contentQueries.length }, null, 2));
if (!passed) process.exitCode = 1;
