import assert from 'node:assert/strict';
import {
  resolveDiscoveryD5RuntimeConfig,
  validateDiscoveryD5Output,
} from '../src/discovery/open-discovery.js';

const candidate = {
  url: 'https://example.com/work',
  title: 'Original work',
  title_zh: '中文标题',
  author: 'Author',
  publication: 'Publication',
  contentType: 'article',
  publishedAt: null,
  estimatedDurationMinutes: 12,
  summary: '中文摘要',
  whyWorthReading: '中文理由',
  evidence: '正文中的具体论证',
  limitations: '',
  tags: [{ zh: '科学方法', en: 'Scientific Method' }],
  category: 'earth_environment',
  extra_info: '{}',
};

const parsed = validateDiscoveryD5Output({ candidates: [candidate] });
assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.sourceLeadId, undefined, 'Open candidates must not fabricate a Lead.');
assert.throws(
  () => validateDiscoveryD5Output({ candidates: Array.from({ length: 4 }, () => candidate) }),
  /<=3/i,
);
assert.throws(
  () => validateDiscoveryD5Output({ candidates: [{ ...candidate, extra_info: '[]' }] }),
  /JSON object/i,
);

// Assert the live output contract, rather than wording in a frozen Prompt fixture.
assert.deepEqual(validateDiscoveryD5Output({ candidates: [] }), []);
assert.deepEqual(parsed[0]?.extraInfo, {});
assert.deepEqual(parsed[0]?.tags, candidate.tags);
assert.throws(() =>
  validateDiscoveryD5Output({ candidates: [{ ...candidate, sourceLeadId: 'invented-lead' }] }),
);
assert.throws(() =>
  validateDiscoveryD5Output({ candidates: [{ ...candidate, tags: [{ zh: '科学方法', en: '' }] }] }),
);

const config = resolveDiscoveryD5RuntimeConfig({
  ...process.env,
  DISCOVERY_D5_TIMEOUT_MS: '120000',
  DISCOVERY_D5_MAX_TURNS: '5',
  CODEX_MODEL: 'test-model',
});
assert.equal(config.timeoutMs, 120000);
assert.equal(config.maxTurns, 5);
assert.equal(config.model, 'test-model');

console.log('Discovery D5 mock tests passed.');

// Real D5 -> validation -> transaction -> review-list path, with only the Agent/DB mocked.
async function testD5Persistence() {
  const { runDiscoveryD5 } = await import('../src/discovery/open-discovery.js');
  const { listInDepthReviewItems } = await import('../src/lib/in-depth-reads.js');
  const { emptyDiscoveryStageUsage } = await import('../src/discovery/execution-diagnostics.js');
  const fetch = {
    url: candidate.url,
    status: 'success' as const,
    content: 'Verified full body',
    content_length: 18,
    returned_content_length: 18,
    content_complete: true,
    truncated: false,
    content_type: 'article_body',
    error: null,
    metadata: {
      title: candidate.title,
      author: 'Author',
      published_time: null,
      source_url: candidate.url,
      status_code: 200,
      publication: candidate.publication,
    },
  };
  const run = async (db: D5Database, output = [candidate], fetches = [fetch]) =>
    runDiscoveryD5(db as unknown as import('pg').Pool, db.run.id, {
      runtime: async () => {
        db.calls++;
        return {
          output: { candidates: output },
          fetches,
          usage: emptyDiscoveryStageUsage(),
          elapsedMs: 1,
          traceIds: [],
          traceFlushed: true,
        };
      },
    });
  const db = new D5Database();
  const good = await run(db);
  assert.equal(good.selectedCount, 1);
  assert.equal(good.endReason, 'candidates_found');
  assert.equal(db.candidates[0]?.category, 'earth_environment');
  assert.equal(db.run.execution_state.d5.endReason, good.endReason);
  const queued = await listInDepthReviewItems(db as unknown as import('pg').Pool);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].url, candidate.url);
  assert.equal(queued[0].reviewStatus, 'pending');
  const resumed = await run(db);
  assert.equal(resumed.skipped, true);
  assert.equal(db.candidates[0]?.category, 'earth_environment');
  assert.equal(db.calls, 1);
  assert.equal(db.candidates.length, 1);
  assert.equal(db.review.size, 1);
  // Retry Open creates a separate Run: retain old queued content, audit the duplicate rejection.
  db.run.id = '00000000-0000-4000-8000-000000000502';
  db.run.execution_state = {};
  const duplicate = await run(db);
  assert.equal(duplicate.rejectedCount, 1);
  assert.equal(duplicate.selectedCount, 0);
  assert.equal(duplicate.endReason, 'no_candidates');
  assert.equal(db.run.execution_state.d5.endReason, 'no_candidates');
  assert.equal(db.review.size, 1);
  assert.equal((await listInDepthReviewItems(db as unknown as import('pg').Pool)).length, 1);

  for (const scenario of [
    { output: [candidate], fetches: [], status: 'unverifiable' },
    {
      output: [{ ...candidate, estimatedDurationMinutes: 31 }],
      fetches: [fetch],
      status: 'rejected',
    },
    { output: [], fetches: [], status: undefined },
  ]) {
    const failed = new D5Database();
    const result = await run(failed, scenario.output, scenario.fetches);
    assert.equal(result.selectedCount, 0);
    assert.equal(result.endReason, 'no_candidates');
    assert.equal(failed.run.execution_state.d5.endReason, 'no_candidates');
    assert.equal(failed.candidates[0]?.status, scenario.status);
    assert.deepEqual(await listInDepthReviewItems(failed as unknown as import('pg').Pool), []);
  }
  const repeated = new D5Database();
  const batch = await run(repeated, [candidate, candidate]);
  assert.equal(batch.discoveredCount, 2);
  assert.equal(batch.selectedCount, 1);
  assert.equal(batch.rejectedCount, 1);
  assert.equal(repeated.review.size, 1);
  assert.equal(repeated.run.execution_state.d5.endReason, 'candidates_found');

  const failure = new D5Database();
  failure.failQueue = true;
  await assert.rejects(() => run(failure), /Mock queue failure/);
  assert.equal(failure.candidates.length, 0, 'Candidate and queue commit atomically');
  assert.equal(failure.review.size, 0);
  assert.equal(failure.run.execution_state.d5.status, 'failed');
  failure.failQueue = false;
  await run(failure);
  assert.equal(failure.candidates.length, 1);
  assert.equal(failure.review.size, 1);
  console.log(
    'D5 persistence/review list, validation, duplicate URLs, completed Resume, independent Retry Open, atomic rollback and post-validation End reason passed.',
  );
}

type StoredCandidate = {
  category: string | null;
  id: string;
  runId: string;
  url: string;
  normalizedUrl: string;
  publication: string;
  status: string;
};
class D5Database {
  calls = 0;
  failQueue = false;
  candidates: StoredCandidate[] = [];
  review = new Set<string>();
  run = {
    id: '00000000-0000-4000-8000-000000000501',
    parent_run_id: null,
    source_lead_id: null,
    run_type: 'open',
    trigger_source: 'manual',
    status: 'running',
    end_reason: null,
    window_start_date: null,
    window_end_date: null,
    input_content_ids: null,
    selection_output: null,
    config_snapshot: {} as Record<string, unknown>,
    execution_state: {} as Record<
      string,
      import('../src/db/schema.js').DiscoveryBranchExecutionState
    >,
    started_at: '2026-10-27T12:00:00Z',
    finished_at: null,
    error_summary: null,
    created_at: '2026-10-27T12:00:00Z',
    updated_at: '2026-10-27T12:00:00Z',
  };
  async connect() {
    const snapshot = structuredClone({
      candidates: this.candidates,
      review: this.review,
      state: this.run.execution_state,
    });
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === 'rollback') {
          this.candidates = snapshot.candidates;
          this.review = snapshot.review;
          this.run.execution_state = snapshot.state;
          return { rows: [] };
        }
        return this.query(sql, values);
      },
      release() {},
    };
  }
  async query(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount?: number }> {
    if (['begin', 'commit'].includes(sql)) return { rows: [] };
    if (sql.includes('from discovery_runs where id')) return { rows: [this.run] };
    if (sql.includes('set config_snapshot = case')) {
      this.run.config_snapshot.d5 ??= JSON.parse(String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('set execution_state = jsonb_set')) {
      this.run.execution_state[String(values[1])] = JSON.parse(String(values[2]));
      return { rows: [], rowCount: 1 };
    }
    if (sql === 'select name, url from sources order by name') return { rows: [] };
    if (sql.includes('select distinct normalized_url'))
      return {
        rows: this.candidates
          .filter((c) => c.runId !== values[1] && (values[0] as string[]).includes(c.normalizedUrl))
          .map((c) => ({ normalized_url: c.normalizedUrl })),
      };
    if (sql.includes('insert into discovery_candidates')) {
      this.candidates.push({
        id: String(values[0]),
        runId: String(values[1]),
        url: String(values[5]),
        normalizedUrl: String(values[6]),
        publication: String(values[10]),
        status: String(values[19]),
        category: (values[20] as string | null) ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('insert into in_depth_candidates')) {
      if (this.failQueue) throw new Error('Mock queue failure');
      this.review.add(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('group by status')) {
      const counts = new Map<string, number>();
      this.candidates
        .filter((c) => c.runId === values[0])
        .forEach((c) => counts.set(c.status, (counts.get(c.status) ?? 0) + 1));
      return { rows: [...counts].map(([status, count]) => ({ status, count: String(count) })) };
    }
    if (sql.includes('from in_depth_candidates idc')) {
      assert.match(sql, /join discovery_candidates dc/);
      assert.match(sql, /where idc.review_status = \$1/);
      assert.match(sql, /order by dc.created_at desc, dc.id desc/);
      return {
        rows:
          values[0] === 'pending'
            ? this.candidates
                .filter((c) => this.review.has(c.id))
                .map((c) => ({
                  id: c.id,
                  discoveryCandidateId: c.id,
                  reviewStatus: 'pending',
                  url: c.url,
                  publication: c.publication,
                }))
            : [],
      };
    }
    throw new Error(`Unexpected D5 SQL: ${sql}`);
  }
}
await testD5Persistence();
