import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool as PoolType } from 'pg';
import { Pool } from 'pg';
import {
  readDiscoveryDailyWindow,
  type DiscoveryWindowInput,
} from '../src/discovery/daily-read-adapter.js';
import {
  createRegularDiscoveryRun,
  finishDiscoveryRun,
  getDiscoveryRun,
  resumeDiscoveryRun,
  startDiscoveryRun,
} from '../src/discovery/run-service.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();

const checks: Array<[string, boolean]> = [];

await testDailyReadAdapter();
await testRunLifecycle();
await testMigrationAgainstDatabase();

const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) process.exitCode = 1;

async function testDailyReadAdapter() {
  const sqlLog: string[] = [];
  const briefPool = {
    query: async (text: string, values?: unknown[]) => {
      sqlLog.push(text);
      const dailyDate = String(values?.[0] ?? '');

      if (text.includes('from events') && text.includes("publication_status = 'published'")) {
        return {
          rows: Array.from({ length: 12 }, (_, index) => ({
            id: `${dailyDate}-event-${index + 1}`,
            rank: index + 1,
            event_date: '2026-10-01',
            created_at: '2026-10-01T00:00:00.000Z',
            title: `Event ${index + 1}`,
            title_zh: `事件 ${index + 1}`,
            summary: 'Summary',
            summary_zh: '摘要',
            tags: ['tag'],
            tags_zh: ['标签'],
            entities: [],
            entities_zh: [],
            source_perspectives: {},
            external_context: null,
          })),
        };
      }
      if (text.includes('where events.id = any')) {
        const eventIds = values?.[0] as string[];
        return {
          rows: eventIds.map((eventId) => ({
            event_id: eventId,
            source: 'Event Source',
            title: 'Source article',
            url: 'https://example.test/source',
          })),
        };
      }
      if (text.includes("pc.routing = 'digest'")) {
        return {
          rows: [contentRow(`${dailyDate}-digest-1`, 1, 'Technology')],
        };
      }
      if (text.includes("pc.routing = 'long_form'")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) =>
            contentRow(`${dailyDate}-long-${index + 1}`, index + 1, 'General'),
          ),
        };
      }
      if (text.includes('char_length') && text.includes('full_content_text')) {
        return { rows: ((values?.[0] as string[]) ?? []).map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  } as unknown as PoolType;

  const input = await readDiscoveryDailyWindow(briefPool, ['2026-10-01', '2026-10-02']);
  const allItems = input.days.flatMap((day) => [...day.events, ...day.digests, ...day.longForm]);

  checks.push(
    [
      'Daily Adapter keeps the explicit two-date window',
      input.dailyDates[0] === '2026-10-01' && input.dailyDates[1] === '2026-10-02',
    ],
    [
      'Daily Adapter reads every published Event without a Top 10 cutoff',
      input.days.every((day) => day.events.length === 12) &&
        !sqlLog
          .filter((sql) => sql.includes("publication_status = 'published'"))
          .some((sql) => /\blimit\b/i.test(sql)),
    ],
    [
      'Digest and Long-form reuse current Brief selection semantics',
      input.days.every((day) => day.digests.length === 1 && day.longForm.length === 10) &&
        sqlLog
          .filter((sql) => sql.includes("pc.routing = 'long_form'"))
          .every((sql) => /limit\s+10/i.test(sql)),
    ],
    [
      'D2 input contains neither URL nor full article text',
      allItems.every(
        (item) => !('url' in item) && !('contentText' in item) && !('fullContentText' in item),
      ),
    ],
    [
      'Daily Adapter computes Direct eligibility without exposing body text',
      input.days.every(
        (day) =>
          day.events.every((item) => !item.directEligible) &&
          [...day.digests, ...day.longForm].every((item) => item.directEligible),
      ),
    ],
    [
      'Input membership preserves Daily attribution for every content ID',
      input.contentIds.event.length === 24 &&
        input.contentIds.digest.length === 2 &&
        input.contentIds.longForm.length === 20 &&
        input.contentIds.event.every((item) => item.id.startsWith(item.dailyDate)),
    ],
  );
}

async function testRunLifecycle() {
  const emptyWindow = windowFixture(['2026-10-01', '2026-10-02']);
  const completeDb = createRunPool(['2026-10-01', '2026-10-02']);
  const pending = await createRegularDiscoveryRun(
    completeDb.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'schedule',
    },
    { readWindow: async () => emptyWindow },
  );
  const queriedPending = await getDiscoveryRun(completeDb.pool, pending.run.id);

  checks.push(
    [
      'daily/success makes an empty Daily input executable rather than blocked',
      pending.run.status === 'pending' &&
        pending.missingDailyDates.length === 0 &&
        pending.run.inputContentIds?.event.length === 0,
    ],
    [
      'Run stores the requested window rather than deriving it from execution time',
      pending.run.windowStartDate === '2026-10-01' && pending.run.windowEndDate === '2026-10-02',
    ],
    [
      'Run query returns the saved deterministic input membership',
      queriedPending?.inputContentIds?.event.length === 0 &&
        queriedPending.windowStartDate === '2026-10-01' &&
        queriedPending.windowEndDate === '2026-10-02',
    ],
  );

  const stage4Db = createRunPool([
    { dailyDate: '2026-10-01', step: 'stage4', status: 'success' },
    { dailyDate: '2026-10-02', step: 'stage4', status: 'success' },
  ]);
  const stage4Ready = await createRegularDiscoveryRun(
    stage4Db.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'manual',
    },
    { readWindow: async () => emptyWindow },
  );
  checks.push([
    'stage4/success independently marks each matching Daily date ready',
    stage4Ready.run.status === 'pending' && stage4Ready.missingDailyDates.length === 0,
  ]);

  const failedUpstreamDb = createRunPool([
    { dailyDate: '2026-10-01', step: 'daily', status: 'failed' },
    { dailyDate: '2026-10-01', step: 'stage4', status: 'failed' },
    { dailyDate: '2026-10-02', step: 'daily', status: 'failed' },
    { dailyDate: '2026-10-02', step: 'stage4', status: 'failed' },
  ]);
  const failedUpstream = await createRegularDiscoveryRun(
    failedUpstreamDb.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'manual',
    },
    { readWindow: async () => emptyWindow },
  );
  checks.push([
    'failed daily and stage4 attempts do not satisfy upstream readiness',
    failedUpstream.run.status === 'blocked' && failedUpstream.missingDailyDates.length === 2,
  ]);

  const running = await startDiscoveryRun(
    completeDb.pool,
    pending.run.id,
    new Date('2026-11-30T12:00:00.000Z'),
  );
  const completed = await finishDiscoveryRun(completeDb.pool, pending.run.id, {
    status: 'completed',
    hasCandidates: false,
    finishedAt: new Date('2026-11-30T12:01:00.000Z'),
  });
  checks.push(
    ['pending → running records execution start', running.status === 'running'],
    [
      'normal empty completion is distinct from upstream failure',
      completed.status === 'completed' && completed.endReason === 'no_candidates',
    ],
  );

  let blockedReadCalled = false;
  const incompleteDb = createRunPool(['2026-10-01']);
  const blocked = await createRegularDiscoveryRun(
    incompleteDb.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'manual',
    },
    {
      readWindow: async () => {
        blockedReadCalled = true;
        return emptyWindow;
      },
    },
  );
  checks.push(
    [
      'an incomplete upstream Daily creates a non-executable blocked Run',
      blocked.run.status === 'blocked' &&
        blocked.run.endReason === 'upstream_not_ready' &&
        blocked.run.inputContentIds === null &&
        blocked.missingDailyDates[0] === '2026-10-02' &&
        !blockedReadCalled,
    ],
    [
      'Run creation is transactional',
      completeDb.commands.includes('begin isolation level repeatable read') &&
        completeDb.commands.includes('commit') &&
        incompleteDb.commands.includes('commit'),
    ],
  );

  const partialDb = createRunPool(['2026-10-01', '2026-10-02']);
  const partialPending = await createRegularDiscoveryRun(
    partialDb.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'manual',
    },
    { readWindow: async () => emptyWindow },
  );
  await startDiscoveryRun(partialDb.pool, partialPending.run.id);
  const partial = await finishDiscoveryRun(partialDb.pool, partialPending.run.id, {
    status: 'partial',
    endReason: 'timeout',
    errorSummary: 'Topic branch timed out',
  });
  checks.push([
    'partial completion retains its reason',
    partial.status === 'partial' &&
      partial.endReason === 'timeout' &&
      partial.errorSummary === 'Topic branch timed out',
  ]);
  partialDb.setSelectionOutput(partialPending.run.id, { leads: [] });
  const resumed = await resumeDiscoveryRun(partialDb.pool, partialPending.run.id);
  checks.push([
    'partial Run with persisted D2 output can resume D4 without creating a new Run',
    resumed.id === partialPending.run.id &&
      resumed.status === 'running' &&
      resumed.finishedAt === null &&
      resumed.errorSummary === null,
  ]);

  const failedDb = createRunPool(['2026-10-01', '2026-10-02']);
  const failedPending = await createRegularDiscoveryRun(
    failedDb.pool,
    {
      dailyDates: ['2026-10-01', '2026-10-02'],
      triggerSource: 'manual',
    },
    { readWindow: async () => emptyWindow },
  );
  await startDiscoveryRun(failedDb.pool, failedPending.run.id);
  const failed = await finishDiscoveryRun(failedDb.pool, failedPending.run.id, {
    status: 'failed',
    endReason: 'error',
    errorSummary: 'Core dependency failed',
  });
  checks.push([
    'failed completion stores its durable failure reason',
    failed.status === 'failed' &&
      failed.endReason === 'error' &&
      failed.errorSummary === 'Core dependency failed',
  ]);
}

async function testMigrationAgainstDatabase() {
  const migration = await readFile(
    new URL('../drizzle/0015_discovery_phase1.sql', import.meta.url),
    'utf8',
  );
  const executionStateMigration = await readFile(
    new URL('../drizzle/0016_discovery_execution_state.sql', import.meta.url),
    'utf8',
  );
  checks.push(
    [
      'Migration includes the four Discovery tables and required indexes',
      [
        'discovery_runs',
        'discovery_trace_spans',
        'discovery_candidates',
        'in_depth_candidates',
        'discovery_candidates_run_lead_idx',
      ].every((name) => migration.includes(`\"${name}\"`)),
    ],
    [
      'Migration enforces polymorphic source and object-only extra_info',
      migration.includes('discovery_candidates_source_check') &&
        migration.includes('discovery_candidates_extra_info_object_check') &&
        migration.includes('jsonb_typeof'),
    ],
    [
      'Discovery execution-state migration adds an object-only durable branch state',
      executionStateMigration.includes('"execution_state"') &&
        executionStateMigration.includes('discovery_runs_execution_state_object_check') &&
        executionStateMigration.includes('jsonb_typeof'),
    ],
  );

  if (!process.env.DATABASE_URL) {
    console.warn(
      '[discovery-phase1] DATABASE_URL is unavailable; isolated migration execution was not verified.',
    );
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  const client = await pool.connect();
  const schemaName = `discovery_test_${randomUUID().replaceAll('-', '')}`;

  try {
    await client.query('begin');
    await client.query(`create schema "${schemaName}"`);
    await client.query(`set local search_path to "${schemaName}"`);
    const isolatedMigration = migration.replaceAll('"public".', `"${schemaName}".`);
    for (const statement of isolatedMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.query(statement);
    }
    for (const statement of executionStateMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.query(statement);
    }

    const regularId = randomUUID();
    const childId = randomUUID();
    const candidateId = randomUUID();
    await client.query(
      `insert into discovery_runs (
        id, run_type, trigger_source, status, window_start_date, window_end_date,
        selection_output
      ) values ($1, 'regular', 'manual', 'pending', '2026-10-01', '2026-10-02',
        '{"leads":[{"leadId":"lead-1"}]}'::jsonb)`,
      [regularId],
    );
    await client.query(
      `insert into discovery_runs (
        id, parent_run_id, source_lead_id, run_type, trigger_source, status
      ) values ($1, $2, 'lead-1', 'single_lead', 'manual', 'pending')`,
      [childId, regularId],
    );
    await client.query(
      `insert into discovery_candidates (
        id, run_id, discovery_path, source_content_type, source_content_id,
        source_lead_id, url, status
      ) values ($1, $2, 'topic', 'event', $3, 'lead-1',
        'https://example.test/work', 'discovered')`,
      [candidateId, childId, randomUUID()],
    );
    const candidate = await client.query<{
      parent_run_id: string;
      run_source_lead_id: string;
      candidate_source_lead_id: string;
      extra_info: Record<string, unknown>;
    }>(
      `select r.parent_run_id, r.source_lead_id as run_source_lead_id,
          c.source_lead_id as candidate_source_lead_id, c.extra_info
        from discovery_candidates c
        join discovery_runs r on r.id = c.run_id
        where c.id = $1`,
      [candidateId],
    );
    checks.push([
      'parent Run, source Lead and Candidate remain traceable',
      candidate.rows[0]?.parent_run_id === regularId &&
        candidate.rows[0]?.run_source_lead_id === 'lead-1' &&
        candidate.rows[0]?.candidate_source_lead_id === 'lead-1' &&
        Object.keys(candidate.rows[0]?.extra_info ?? {}).length === 0,
    ]);

    checks.push([
      'source pair constraint rejects half-populated polymorphic references',
      await expectConstraintFailure(
        client,
        `insert into discovery_candidates (
          run_id, discovery_path, source_content_type, source_lead_id, url, status
        ) values ($1, 'topic', 'event', 'lead-1', 'https://example.test/bad', 'discovered')`,
        [childId],
      ),
    ]);
    checks.push([
      'extra_info rejects non-object JSON',
      await expectConstraintFailure(
        client,
        `insert into discovery_candidates (
          run_id, discovery_path, source_lead_id, url, status, extra_info
        ) values ($1, 'topic', 'lead-1', 'https://example.test/bad-json',
          'discovered', '[]'::jsonb)`,
        [childId],
      ),
    ]);
    checks.push([
      'Run relationship constraint rejects self-parenting',
      await expectConstraintFailure(
        client,
        `insert into discovery_runs (
          id, parent_run_id, source_lead_id, run_type, trigger_source, status
        ) values ($1, $1, 'lead-1', 'single_lead', 'manual', 'pending')`,
        [randomUUID()],
      ),
    ]);

    await client.query(
      `insert into discovery_trace_spans (
        run_id, trace_id, span_id, span_type
      ) values ($1, 'trace-1', 'span-1', 'agent')`,
      [childId],
    );
    checks.push([
      'Trace ID and Span ID are unique together',
      await expectConstraintFailure(
        client,
        `insert into discovery_trace_spans (
          run_id, trace_id, span_id, span_type
        ) values ($1, 'trace-1', 'span-1', 'function')`,
        [childId],
      ),
    ]);

    await client.query(
      `insert into in_depth_candidates (
        discovery_candidate_id, review_status
      ) values ($1, 'pending')`,
      [candidateId],
    );
    checks.push([
      'a Discovery Candidate can enter the review queue only once',
      await expectConstraintFailure(
        client,
        `insert into in_depth_candidates (
          discovery_candidate_id, review_status
        ) values ($1, 'pending')`,
        [candidateId],
      ),
    ]);

    const indexes = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = $1`,
      [schemaName],
    );
    checks.push([
      'migration creates the documented Discovery indexes',
      [
        'discovery_runs_parent_run_id_idx',
        'discovery_runs_status_started_at_idx',
        'discovery_trace_spans_trace_span_unique',
        'discovery_candidates_run_lead_idx',
        'in_depth_candidates_candidate_unique',
      ].every((name) => indexes.rows.some((row) => row.indexname === name)),
    ]);
  } finally {
    await client.query('rollback');
    client.release();
    await pool.end();
  }
}

async function expectConstraintFailure(
  client: import('pg').PoolClient,
  sql: string,
  values: unknown[],
): Promise<boolean> {
  const savepoint = `constraint_${randomUUID().replaceAll('-', '')}`;
  await client.query(`savepoint "${savepoint}"`);
  try {
    await client.query(sql, values);
    await client.query(`rollback to savepoint "${savepoint}"`);
    return false;
  } catch {
    await client.query(`rollback to savepoint "${savepoint}"`);
    return true;
  }
}

function contentRow(id: string, rank: number, category: string) {
  return {
    id,
    rank,
    title: id,
    title_zh: null,
    summary: 'Summary',
    summary_zh: '摘要',
    category,
    source: 'Content Source',
    url: 'https://example.test/content',
    published_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    hasFullContent: false,
  };
}

function windowFixture(dailyDates: readonly [string, string]): DiscoveryWindowInput {
  return {
    dailyDates,
    days: [
      { dailyDate: dailyDates[0], events: [], digests: [], longForm: [] },
      { dailyDate: dailyDates[1], events: [], digests: [], longForm: [] },
    ],
    contentIds: { event: [], digest: [], longForm: [] },
  };
}

type UpstreamRunFixture = {
  dailyDate: string;
  step: 'daily' | 'stage4';
  status: 'success' | 'failed';
};

function createRunPool(upstreamRuns: Array<string | UpstreamRunFixture>) {
  const normalizedUpstreamRuns = upstreamRuns.map<UpstreamRunFixture>((run) =>
    typeof run === 'string' ? { dailyDate: run, step: 'daily', status: 'success' } : run,
  );
  const rows = new Map<string, Record<string, unknown>>();
  const commands: string[] = [];
  const query = async (text: string, values?: unknown[]) => {
    const normalized = text.trim().replaceAll(/\s+/g, ' ').toLowerCase();
    commands.push(normalized);
    if (
      normalized === 'begin isolation level repeatable read' ||
      normalized === 'commit' ||
      normalized === 'rollback'
    ) {
      return { rows: [] };
    }
    if (normalized.includes('from pipeline_runs')) {
      const requestedDates = new Set((values?.[0] as string[] | undefined) ?? []);
      const completedDates = new Set(
        normalizedUpstreamRuns
          .filter(
            (run) =>
              requestedDates.has(run.dailyDate) &&
              run.status === 'success' &&
              (run.step === 'daily' || run.step === 'stage4'),
          )
          .map((run) => run.dailyDate),
      );
      return {
        rows: [...completedDates].map((daily_date) => ({ daily_date })),
      };
    }
    if (normalized.startsWith('insert into discovery_runs')) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const row = {
        id,
        parent_run_id: null,
        source_lead_id: null,
        run_type: 'regular',
        trigger_source: values?.[0],
        status: values?.[1],
        end_reason: values?.[2],
        window_start_date: values?.[3],
        window_end_date: values?.[4],
        input_content_ids: values?.[5] ? JSON.parse(String(values[5])) : null,
        selection_output: null,
        config_snapshot: values?.[6] ? JSON.parse(String(values[6])) : null,
        started_at: null,
        finished_at: values?.[7] ?? null,
        error_summary: values?.[8] ?? null,
        created_at: now,
        updated_at: now,
      };
      rows.set(id, row);
      return { rows: [row] };
    }
    if (normalized.startsWith('update discovery_runs')) {
      const row = rows.get(String(values?.[0]));
      if (!row) return { rows: [] };
      if (normalized.includes("set status = 'running'")) {
        const isResume = normalized.includes("status in ('partial', 'failed')");
        if (
          isResume
            ? !['partial', 'failed'].includes(String(row.status)) || !row.selection_output
            : row.status !== 'pending'
        ) {
          return { rows: [] };
        }
        row.status = 'running';
        row.finished_at = null;
        row.end_reason = null;
        row.error_summary = null;
        if (!isResume) row.started_at = values?.[1];
      } else {
        if (row.status !== 'running') return { rows: [] };
        row.status = values?.[1];
        row.end_reason = values?.[2];
        row.error_summary = values?.[3];
        row.finished_at = values?.[4];
      }
      row.updated_at = new Date().toISOString();
      return { rows: [row] };
    }
    if (normalized.includes('from discovery_runs where id')) {
      const row = rows.get(String(values?.[0]));
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  const pool = {
    connect: async () => client,
    query,
  } as unknown as PoolType;
  return {
    pool,
    commands,
    setSelectionOutput: (runId: string, selectionOutput: Record<string, unknown>) => {
      const row = rows.get(runId);
      if (row) row.selection_output = selectionOutput;
    },
  };
}
