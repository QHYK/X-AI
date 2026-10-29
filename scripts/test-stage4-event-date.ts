import { deriveEventDate } from '../src/processing/event-date.js';
import {
  prepareStage4Event,
  loadStage4RecentEvents,
} from '../src/processing/stage4-event-processing.js';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildStage4EventEnrichmentUserPrompt } from '../src/prompts/stage4-event-enrichment.js';
import { validateStage4EventEnrichmentOutput } from '../src/processing/stage4-contract.js';

type Check = {
  name: string;
  passed: boolean;
  detail?: unknown;
};

const checks: Check[] = [];

checks.push({
  name: 'A. same-day sources derive same Shanghai date',
  passed:
    deriveEventDate({
      publishedAtValues: ['2026-08-16T01:00:00Z', '2026-08-16T15:00:00Z'],
      workflowRunTimestamp: '2026-08-17T00:00:00Z',
    }).eventDate === '2026-08-16',
});

checks.push({
  name: 'B. UTC timestamps crossing Shanghai midnight select earliest Shanghai date',
  passed:
    deriveEventDate({
      publishedAtValues: ['2026-08-16T15:50:00Z', '2026-08-16T16:20:00Z'],
      workflowRunTimestamp: '2026-08-17T00:00:00Z',
    }).eventDate === '2026-08-16',
});

checks.push({
  name: 'C. null published_at values are ignored',
  passed:
    deriveEventDate({
      publishedAtValues: [null, '2026-08-16T16:20:00Z'],
      workflowRunTimestamp: '2026-08-17T00:00:00Z',
    }).eventDate === '2026-08-17',
});

const fallback = deriveEventDate({
  publishedAtValues: [null, null],
  workflowRunTimestamp: '2026-08-16T17:00:00Z',
});
checks.push({
  name: 'D. all null published_at falls back to workflow Shanghai date',
  passed: fallback.eventDate === '2026-08-17' && fallback.source === 'workflow_date_fallback',
  detail: fallback,
});

const contract = validateStage4EventEnrichmentOutput({
  event_title: 'Test title',
  event_title_zh: '测试标题',
  event_tags: ['tag'],
  event_tags_zh: ['标签'],
  event_entities: ['Entity'],
  event_entities_zh: ['实体'],
  event_summary: 'Summary.',
  event_summary_zh: '摘要。',
  source_perspectives: [{ source: 'Source', summary: '来源摘要。' }],
  external_context: {
    performed: false,
    sources: [],
    sources_summary: '',
  },
});
checks.push({
  name: 'E. Stage 4 output without event_date passes contract',
  passed: contract.success,
  detail: contract,
});

const attributedToDaily = prepareStage4Event(
  {
    eventGroupId: 'event-group-1',
    eventReviewItemId: 'review-item-1',
    eventHint: 'Late-arrival event',
    aiRank: 1,
    displayRank: 1,
    processedContentIds: ['content-1'],
  },
  new Map([
    [
      'content-1',
      {
        processedContentId: 'content-1',
        title: 'Late source',
        summary: 'Summary',
        entities: [],
        source: 'Source',
        url: 'https://example.com/late',
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ],
  ]),
  new Date('2026-08-26T00:00:00.000Z'),
  '2026-08-25',
);
checks.push({
  name: 'F. Stage 4 target dailyDate overrides a late source published_at date',
  passed:
    attributedToDaily.eventDate.eventDate === '2026-08-25' &&
    attributedToDaily.eventDate.source === 'daily_attribution',
  detail: attributedToDaily.eventDate,
});

const failures = checks.filter((check) => !check.passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

// The database owns calendar subtraction (DATE - integer), so timezone and DST
// conversions cannot shift the window. Verify the SQL contract and bound date.
for (const date of ['2026-10-29', '2026-11-01', '2027-01-01', '2028-03-01']) {
  const db = {
    query: async (sql: string, params: unknown[]) => {
      assert.deepEqual(params, [date]);
      assert.match(sql, /r.daily_date >= \$1::date - 2 and r.daily_date < \$1::date/);
      assert.match(sql, /r.status = 'success' and e.publication_status = 'published'/);
      assert.match(sql, /e.event_date = r.daily_date/);
      assert.doesNotMatch(sql, /now\(|current_date|limit\s+\d/i);
      return {
        rows: [{ title: 'Previous event', summary: 'Stored summary', internal: 'excluded' }],
      };
    },
  } as unknown as Pick<Pool, 'query'>;
  const recent = await loadStage4RecentEvents(db, date);
  assert.deepEqual(recent, [{ title: 'Previous event', summary: 'Stored summary' }]);
  const input = attributedToDaily.input;
  const rendered = JSON.parse(buildStage4EventEnrichmentUserPrompt(input));
  assert.equal('recent_events' in rendered, false);
  assert.deepEqual(rendered.sources, attributedToDaily.input.sources);
  assert.equal(rendered.event_hint, attributedToDaily.input.event_hint);
}
const empty = await loadStage4RecentEvents(
  { query: async () => ({ rows: [] }) } as unknown as Pick<Pool, 'query'>,
  '2026-10-29',
);
assert.deepEqual(empty, []);
assert.deepEqual(
  JSON.parse(buildStage4EventEnrichmentUserPrompt({ event_hint: 'Current event', sources: [] }))
    .recent_events,
  undefined,
);
console.log(
  'Stage4 recent_events: business-date SQL window, published-only filter, minimal fields, empty context and unchanged current event passed.',
);
