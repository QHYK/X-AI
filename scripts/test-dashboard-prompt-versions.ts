import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { getDashboardData } from '../src/lib/dashboard.js';
import { getDiscoveryRunForDate } from '../src/lib/discovery-dashboard.js';
import { loadDashboardPromptVersions } from '../src/lib/dashboard-prompt-versions.js';
const keys = [
  'daily.stage1.content_understanding',
  'daily.stage2.event_merge',
  'daily.stage3.event_ranking',
  'daily.stage3.digest_ranking',
  'daily.stage3.long_form_ranking',
  'daily.stage4.event_enrichment',
  'discovery.d2.topic_selection',
  'discovery.d3.topic_discovery',
  'discovery.d4.direct_verification',
  'discovery.d5.open_discovery',
  'discovery.d5.open_discovery',
];
const versions = keys.map((key, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  key,
  version: i + 2,
}));
const id = (index: number) => versions[index].id;
let lookups = 0;
const root = await mkdtemp(join(tmpdir(), 'dashboard-prompt-'));
try {
  for (const [stage, data] of Object.entries({
    stage1: { promptVersionIds: { [keys[0]]: id(0) }, prompt_version: 'v999' },
    stage2: { prompt_version: id(1) },
    stage3: {
      promptVersions: { [keys[2]]: 'v999' },
      promptVersionIds: { [keys[2]]: id(2), [keys[3]]: id(3), [keys[4]]: id(4) },
    },
    stage4: { promptVersionIds: { [keys[5]]: id(5) } },
  })) {
    const dir = join(root, 'runtime', stage, 'run');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({
        stage,
        daily_date: '2026-10-27',
        started_at: '2026-10-27T01:00:00Z',
        ...data,
      }),
    );
  }
  let pipelineRows: unknown[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('from prompt_versions v')) {
        lookups++;
        assert.match(sql, /v.id = any\(\$1::uuid\[\]\)/);
        assert.match(sql, /v.status = 'published'/);
        assert.match(sql, /r.kind = 'request'/);
        assert.doesNotMatch(sql, /active_version_id/);
        return { rows: versions.filter((v) => (values[0] as string[]).includes(v.id)) };
      }
      if (sql.includes('from pipeline_runs')) return { rows: pipelineRows };
      if (sql.includes('as raw_articles'))
        return { rows: [{ raw_articles: 0, processed_contents: 0, events: 0 }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const data = await getDashboardData(db, {
    detailDate: '2026-10-27',
    now: new Date('2026-10-28T01:00:00Z'),
    rootDir: root,
  });
  assert.equal(lookups, 1, 'Daily batches all displayed Prompt IDs');
  assert.equal(data.details.stages.stage1?.promptVersion, 'v2');
  assert.equal(data.details.stages.stage2?.promptVersion, 'v3');
  assert.deepEqual(data.details.stages.stage3?.promptVersions, {
    event: 'v4',
    digest: 'v5',
    longForm: 'v6',
  });
  assert.equal(data.details.stages.stage4?.promptVersion, 'v7');

  pipelineRows = ['stage1', 'stage2', 'stage3', 'stage4'].map((step, index) => ({
    daily_date: '2026-10-27',
    step,
    status: 'success',
    provider: 'test',
    model: 'test',
    started_at: '2026-10-27T01:00:00Z',
    finished_at: '2026-10-27T02:00:00Z',
    error_summary: null,
    metrics:
      step === 'stage3'
        ? { prompt_versions: { event: id(2), digest: id(3), long_form: id(4) } }
        : { prompt_version: id(index === 3 ? 5 : index) },
  }));
  const logged = await getDashboardData(db, {
    detailDate: '2026-10-27',
    now: new Date('2026-10-28T01:00:00Z'),
    rootDir: root,
  });
  assert.equal(logged.details.stages.stage1?.promptVersion, 'v2');
  assert.equal(logged.details.stages.stage2?.promptVersion, 'v3');
  assert.deepEqual(logged.details.stages.stage3?.promptVersions, {
    event: 'v4',
    digest: 'v5',
    longForm: 'v6',
  });
  assert.equal(logged.details.stages.stage4?.promptVersion, 'v7');
  pipelineRows = [
    {
      daily_date: '2026-10-27',
      step: 'stage4',
      status: 'failed',
      started_at: '2026-10-27T03:00:00Z',
      finished_at: null,
      metrics: { prompt_version: 'missing-version' },
    },
  ];
  const missing = await getDashboardData(db, {
    detailDate: '2026-10-27',
    now: new Date('2026-10-28T01:00:00Z'),
    rootDir: root,
  });
  assert.equal(missing.details.stages.stage4?.promptVersion, null);
  assert.equal(missing.details.stages.stage4?.promptVersionRecorded, true);
  const regular = {
    id: 'regular',
    run_type: 'regular',
    status: 'completed',
    end_reason: 'candidates_found',
    started_at: '2026-10-27T01:00:00Z',
    finished_at: '2026-10-27T02:00:00Z',
    run_count: 1,
    candidate_count: 1,
    review_count: 1,
    execution_state: {
      d2: { status: 'completed' },
      d3: { status: 'completed' },
      d4: { status: 'completed' },
    },
    config_snapshot: {
      promptVersions: Object.fromEntries(versions.slice(6, 10).map((v) => [v.key, v.id])),
    },
  };
  let d5 = {
    id: 'open',
    run_type: 'open',
    d5: { status: 'completed' },
    executed_at: '2026-10-27T03:00:00Z',
    config_snapshot: { promptVersions: { [keys[10]]: id(10) } },
  };
  const discoveryDb = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes('from prompt_versions v')) return db.query(sql, values);
      return { rows: sql.includes("execution_state->'d5' as d5") ? [d5] : [regular] };
    },
  } as unknown as Pool;
  lookups = 0;
  const discovery = await getDiscoveryRunForDate(discoveryDb, '2026-10-27');
  assert.equal(lookups, 1);
  assert.deepEqual(discovery?.regularRun?.promptVersions, {
    d2: 'v8',
    d3: 'v9',
    d4: 'v10',
    d5: 'v11',
  });
  assert.equal(discovery?.d5?.runId, 'open');
  assert.equal(
    discovery?.d5?.promptVersion,
    'v12',
    'Open uses its own binding, not Regular or Active',
  );
  // Simulate Active changing: the existing binding still selects its original exact version.
  d5 = { ...d5, config_snapshot: { promptVersions: { [keys[10]]: id(9) } } };
  assert.equal((await getDiscoveryRunForDate(discoveryDb, '2026-10-27'))?.d5?.promptVersion, 'v11');
  d5 = { ...d5, config_snapshot: { promptVersions: { [keys[10]]: 'v12' } } };
  assert.equal((await getDiscoveryRunForDate(discoveryDb, '2026-10-27'))?.d5?.promptVersion, null);
  const label = await loadDashboardPromptVersions(db, [
    id(0),
    id(0),
    'not-a-uuid',
    '00000000-0000-4000-8000-999999999999',
  ]);
  assert.equal(label(id(0), keys[0]), 'v2');
  assert.equal(label(id(0), keys[1]), null, 'Wrong Request key must not be displayed');
  assert.equal(label('v2', keys[0]), null);
  assert.equal(label(null, keys[0]), null);
  assert.equal(label('00000000-0000-4000-8000-999999999999', keys[0]), null);
  const noLookup = {
    query: () => {
      throw new Error('Must not query without valid IDs');
    },
  } as unknown as Pool;
  const empty = await loadDashboardPromptVersions(noLookup, [null, 'v3', 'bad']);
  assert.equal(empty('bad', keys[0]), null);
  console.log(
    'Dashboard exact Published Request versions: Daily 1–4/Stage3 split, D2–D5/Open isolation, batching, historical IDs and missing/mismatched ID fallback passed.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
