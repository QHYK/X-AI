import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  listRuntimeFiles,
  readRuntimeFile,
  resolveRuntimeDirectory,
  RUNTIME_FILE_LIMIT,
} from '../src/lib/dashboard-runtime.js';
import {
  safelyRecordPipelineRuntime,
  finishPipelineRun,
  safelyFinishPipelineRun,
} from '../src/processing/pipeline-run-log.js';

const root = await mkdtemp(join(tmpdir(), 'dashboard-runtime-'));
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const directory = 'runtime/stage3/2026-10-29T00-00-00-000Z';
const directory2 = 'runtime/stage3/2026-10-29T01-00-00-000Z';
try {
  await mkdir(join(root, directory, 'events'), { recursive: true });
  await mkdir(join(root, directory2), { recursive: true });
  await mkdir(join(root, directory, 'empty'), { recursive: true });
  assert.deepEqual(await listRuntimeFiles(directory, 'empty', root), []);
  await writeFile(join(root, directory, 'empty.txt'), '');
  assert.equal(await readRuntimeFile(directory, 'empty.txt', root), '');
  await writeFile(join(root, directory, 'invalid.json'), '{not valid JSON');
  assert.equal(await readRuntimeFile(directory, 'invalid.json', root), '{not valid JSON');
  await writeFile(
    join(root, directory, 'run.json'),
    JSON.stringify({
      attempt: id,
      api_key: 'hidden',
      usage: { input_tokens: 20 },
      message: 'Bearer private',
      url: 'postgres://user:pass@host/db',
    }),
  );
  await writeFile(
    join(root, directory, 'events', 'attempt.jsonl'),
    '{"secret":"hidden"}\nnot JSON\n',
  );
  await writeFile(join(root, directory, 'private.env'), 'password=hidden');
  await writeFile(join(root, directory, 'large.txt'), 'x'.repeat(RUNTIME_FILE_LIMIT + 1));
  await writeFile(join(root, directory2, 'run.json'), JSON.stringify({ attempt: other }));
  await symlink(join(root, directory2), join(root, directory, 'link'));
  const pool = {
    query: async (_sql: string, values: unknown[]) => ({
      rows: [
        {
          step: 'stage3',
          status: 'failed',
          metrics: { runtime_dir: values[0] === id ? directory : directory2 },
        },
      ],
    }),
  } as unknown as Pool;
  assert.equal(await resolveRuntimeDirectory(pool, id), directory);
  assert.equal(await resolveRuntimeDirectory(pool, other), directory2);
  const entries = await listRuntimeFiles(directory, '', root);
  assert(entries.some((entry) => entry.directory && entry.name === 'events'));
  assert(!entries.some((entry) => ['private.env', 'link'].includes(entry.name)));
  const text = await readRuntimeFile(directory, 'run.json', root);
  assert.match(text, /\n  "attempt"/);
  assert(
    !text.includes('hidden') && !text.includes('user:pass') && !text.includes('Bearer private'),
  );
  assert.match(text, /input_tokens": 20/);
  assert.match(await readRuntimeFile(directory, 'events/attempt.jsonl', root), /REDACTED/);
  assert.match(await readRuntimeFile(directory2, 'run.json', root), new RegExp(other));
  for (const path of [
    '../run.json',
    '/etc/passwd',
    'events/../../run.json',
    'link/run.json',
    'private.env',
  ]) {
    await assert.rejects(() => readRuntimeFile(directory, path, root));
  }
  await assert.rejects(() => readRuntimeFile(directory, 'large.txt', root), /1 MiB/);
  await assert.rejects(() => readRuntimeFile(directory, 'missing.json', root), /ENOENT/);
  assert.deepEqual(
    await listRuntimeFiles(directory2, '', root).then((items) => items.map((item) => item.name)),
    ['run.json'],
  );
  const historical = (step: string, status = 'failed', count = '1') =>
    ({
      query: async (sql: string) => ({
        rows: sql.includes('count(*)')
          ? [{ count }]
          : [{ step, status, started_at: '2026-10-29T00:00:00.000Z', metrics: {} }],
      }),
    }) as unknown as Pool;
  assert.equal(
    await resolveRuntimeDirectory(historical('stage2'), id),
    'runtime/stage2/2026-10-29T00-00-00-000Z',
  );
  await assert.rejects(() => resolveRuntimeDirectory(historical('stage3'), id), /No reliable/);
  await assert.rejects(
    () => resolveRuntimeDirectory(historical('stage2', 'failed', '2'), id),
    /No reliable/,
  );
  await assert.rejects(
    () => resolveRuntimeDirectory(historical('stage2', 'success'), id),
    /non-success/,
  );
  await assert.rejects(() => resolveRuntimeDirectory(pool, '../x'), /Invalid Run/);

  // SQL contract: JSON field update, guarded fixed pointer and preservation in every finish mode.
  const queries: { sql: string; values: unknown[] }[] = [];
  let storedMetrics: Record<string, unknown> = { checkpoint: { done: true } };
  const observer = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('jsonb_set(metrics')) {
        if (storedMetrics.runtime_dir && storedMetrics.runtime_dir !== values[1])
          return { rows: [] };
        storedMetrics.runtime_dir = values[1];
      } else {
        const prior = storedMetrics;
        storedMetrics = {
          ...(sql.includes('metrics=metrics ||') ? prior : {}),
          ...JSON.parse(values[5] as string),
          ...(prior.runtime_dir ? { runtime_dir: prior.runtime_dir } : {}),
        };
      }
      return { rows: [{ id }] };
    },
  } as unknown as Pool;
  await safelyRecordPipelineRuntime(observer, id, join(process.cwd(), directory));
  assert.match(queries[0]!.sql, /jsonb_set\(metrics/);
  assert.match(queries[0]!.sql, /not metrics \? 'runtime_dir'/);
  assert.equal(queries[0]!.values[1], directory);
  assert.deepEqual(
    storedMetrics.checkpoint,
    { done: true },
    'Observation preserves existing metrics',
  );
  for (const status of ['success', 'failed', 'partial'] as const) {
    for (const mergeMetrics of [false, true]) {
      await finishPipelineRun(observer, id, {
        status,
        mergeMetrics,
        metrics: { llm_calls: 3, runtime_dir: 'must-not-overwrite' },
      });
      assert.equal(
        storedMetrics.runtime_dir,
        directory,
        `${status} preserves exact Runtime directory`,
      );
      assert.match(
        queries.at(-1)!.sql,
        /jsonb_build_object\('runtime_dir', metrics->'runtime_dir'\)/,
      );
    }
  }
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    const failure = {
      query: async () => {
        throw new Error('mock database failure');
      },
    } as unknown as Pool;
    await safelyRecordPipelineRuntime(failure, id, join(process.cwd(), directory));
    await safelyFinishPipelineRun(failure, id, { status: 'failed' });
    assert.equal(errors.length, 2, 'Observation failures log without propagating');
    await safelyRecordPipelineRuntime(observer, id, join(process.cwd(), directory2));
    assert.equal(errors.length, 3, 'A conflicting pointer is reported, not overwritten');
    assert.equal(storedMetrics.runtime_dir, directory);
  } finally {
    console.error = original;
  }
  console.log(
    'PASS: exact attempt mapping, historical limits, lazy file access, redaction, paths/symlinks, size and auxiliary logging SQL contracts.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
