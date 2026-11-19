import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { getDiscoveryRun } from '@/discovery/run-service.js';
import {
  DiscoveryJobConflict,
  submitDiscoveryJob,
  submitDiscoveryD2Retry,
  submitStandaloneDiscoveryJob,
} from '@/discovery/background-jobs.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Input = z.union([
  z
    .object({
      mode: z.literal('standalone'),
      researchTopic: z.string().trim().min(1).max(16000),
      referenceUrl: z
        .url()
        .max(2048)
        .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
        .nullable(),
      instructions: z.string().trim().max(8000).nullable(),
      requestId: z.string().regex(/^[a-f0-9]{32}$/),
      confirmPaid: z.literal(true),
    })
    .strict(),
  z
    .object({
      date: z.iso.date(),
      mode: z.enum(['regular', 'open']),
      requestId: z.string().regex(/^[a-f0-9]{32}$/),
      confirmPaid: z.literal(true),
    })
    .strict(),
  z
    .object({
      mode: z.literal('d2'),
      runId: z.uuid(),
      requestId: z.string().regex(/^[a-f0-9]{32}$/),
      confirmPaid: z.literal(true),
    })
    .strict(),
]);
export async function POST(request: Request) {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const parsed = Input.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: 'Invalid date, mode, request ID or paid confirmation.' },
      { status: 400 },
    );
  try {
    const run =
      parsed.data.mode === 'standalone'
        ? await submitStandaloneDiscoveryJob(getDatabasePool(), parsed.data)
        : parsed.data.mode === 'd2'
          ? await submitDiscoveryD2Retry(getDatabasePool(), parsed.data)
          : await submitDiscoveryJob(getDatabasePool(), parsed.data);
    return Response.json(
      { id: run.id, status: run.status, errorSummary: run.errorSummary },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof DiscoveryJobConflict)
      return Response.json({ error: error.message }, { status: 409 });
    console.error('Discovery submission failed.', error);
    return Response.json({ error: 'Discovery submission failed.' }, { status: 500 });
  }
}
export async function GET(request: Request) {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('history') === 'standalone') {
      const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
      const result = await getDatabasePool().query(
        `select id, status, created_at, error_summary,
      config_snapshot->'openContext' as input from discovery_runs
      where run_type = 'open' and parent_run_id is null and config_snapshot->'openContext'->>'kind' = 'standalone'
      order by created_at desc, id desc limit 20 offset $1`,
        [Math.floor(offset)],
      );
      return Response.json({ runs: result.rows }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const id = z.uuid().safeParse(new URL(request.url).searchParams.get('id'));
    if (!id.success) return Response.json({ error: 'Invalid Run ID.' }, { status: 400 });
    const run = await getDiscoveryRun(getDatabasePool(), id.data);
    if (!run) return Response.json({ error: 'Run not found.' }, { status: 404 });
    const candidates = await getDatabasePool().query(
      `select dc.id, dc.title, dc.title_zh, dc.publication,
      dc.why_worth_reading, dc.status, idc.id as review_id from discovery_candidates dc
      left join in_depth_candidates idc on idc.discovery_candidate_id = dc.id
      where dc.run_id = $1 order by dc.created_at, dc.id`,
      [run.id],
    );
    return Response.json(
      {
        id: run.id,
        status: run.status,
        errorSummary: run.errorSummary,
        executionState: run.executionState,
        endReason: run.endReason,
        candidates: candidates.rows,
        input: run.configSnapshot?.openContext,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Discovery status failed.', error);
    return Response.json({ error: 'Discovery status unavailable.' }, { status: 500 });
  }
}
