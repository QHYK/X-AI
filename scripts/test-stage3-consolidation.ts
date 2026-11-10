import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  validateConsolidation,
  type ConsolidationInput,
} from '../src/processing/stage3-consolidation-llm.js';
import { writeStage3Step } from '../src/processing/stage3-progress.js';
import { getDashboardData } from '../src/lib/dashboard.js';
import { resolveDailyScope } from '../src/lib/daily-scope.js';
const event = randomUUID(),
  other = randomUUID(),
  first = randomUUID(),
  second = randomUUID();
const input: ConsolidationInput = {
  category: 'Company',
  events: [
    { event_group_id: event, hint: 'Earnings announcement' },
    { event_group_id: other, hint: 'A separate event' },
  ],
  candidates: [first, second].map((id) => ({
    id,
    title: 'Report',
    summary: 'One earnings announcement',
    source: 'Source',
  })),
};
assert.deepEqual(validateConsolidation({ matches: [] }, input), { matches: [] });
assert.equal(
  validateConsolidation(
    { matches: [{ event_group_id: event, digest_content_ids: [first, second] }] },
    input,
  ).matches[0].digest_content_ids.length,
  2,
);
for (const invalid of [
  { matches: [{ event_group_id: randomUUID(), digest_content_ids: [first] }] },
  { matches: [{ event_group_id: event, digest_content_ids: [randomUUID()] }] },
  { matches: [{ event_group_id: event, digest_content_ids: [first, first] }] },
  {
    matches: [
      { event_group_id: event, digest_content_ids: [first] },
      { event_group_id: other, digest_content_ids: [first] },
    ],
  },
  { matches: [{ event_group_id: event, digest_content_ids: [] }] },
  { matches: [{ event_group_id: event, digest_content_ids: [first], invented: 'field' }] },
  { matches: 'not an array' },
])
  assert.throws(() => validateConsolidation(invalid, input));
assert.equal(
  validateConsolidation(
    {
      matches: [
        { event_group_id: event, digest_content_ids: [first] },
        { event_group_id: event, digest_content_ids: [second] },
      ],
    },
    input,
  ).matches.length,
  2,
);
// Accuracy of same-event vs independent analysis is a Prompt/evaluation concern; code never invents semantic matches.
let detailSql = '';
const patches: unknown[][] = [];
const detailsDb = {
  query: async (sql: string, args: unknown[]) => {
    detailSql = sql;
    patches.push(args);
    return { rows: [], rowCount: 1 };
  },
} as unknown as Pool;
const attemptId = randomUUID();
await Promise.all(
  ['Company', 'Policy'].map((category) =>
    writeStage3Step(detailsDb, attemptId, 'consolidation', category, {
      status: 'success',
      matched_count: 0,
    }),
  ),
);
assert.match(detailSql, /coalesce\(details->\$2::text/);
assert.match(detailSql, /jsonb_build_object\(\$3::text,\$4::jsonb\)/);
assert.equal(
  patches[0][0],
  patches[1][0],
  'Category patches target the same attempt without replacing its whole details',
);
await writeStage3Step(detailsDb, randomUUID(), 'event_ranking', null, { status: 'running' });
assert.notEqual(patches[0][0], patches[2][0], 'Separate attempts retain distinct identities');
assert.deepEqual(new Set(patches.slice(0, 2).map((p) => p[2])), new Set(['Company', 'Policy']));
await assert.rejects(
  writeStage3Step(
    { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
    randomUUID(),
    'event_ranking',
    null,
    { status: 'success' },
  ),
  /could not be saved/,
);
const date = '2026-10-29';
let correctionSql = '';
const pool = {
  query: async (sql: string) => {
    if (sql.includes('as raw_articles'))
      return { rows: [{ raw_articles: 0, processed_contents: 0, events: 0 }] };
    if (sql.includes('as routing_corrections')) {
      correctionSql = sql;
      return {
        rows: [
          {
            date,
            total: 12,
            event: 8,
            digest: 4,
            long_form: 0,
            inspiration: 0,
            routing_corrections: 2,
          },
        ],
      };
    }
    return { rows: [] };
  },
} as unknown as Pool;
const dashboard = await getDashboardData(pool, {
  now: new Date('2026-11-01T12:00:00Z'),
  overviewScopes: [resolveDailyScope(date)],
  detailDate: date,
  rootDir: '/private/tmp/no-stage3-consolidation-runtime',
});
assert.equal(dashboard.days[0].routingCorrections, 2);
assert.equal(dashboard.days[0].processed.total, 12, 'Existing volume metrics remain independent');
assert.match(correctionSql, /count\(distinct f.target_id\)/);
assert.match(correctionSql, /corrected.daily_date=scope.date::date/);
assert.match(correctionSql, /f.feedback_type='routing_error'/);
assert.match(correctionSql, /f.after_value->>'source'='stage3_consolidation'/);
assert.match(correctionSql, /f.before_value->>'routing'='digest'/);
assert.match(correctionSql, /f.after_value->>'routing'='event'/);
console.log(
  'PASS consolidation strict schema/UUID membership/unique assignments, category-local JSONB patches, attempt identity, and Daily routing corrections aggregation contract. No live PostgreSQL or model requests.',
);
