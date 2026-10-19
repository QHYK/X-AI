import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { getDiscoveryRun } from '@/discovery/run-service.js';
import { DiscoveryJobConflict, submitDiscoveryJob } from '@/discovery/background-jobs.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Input = z
  .object({
    date: z.iso.date(),
    mode: z.enum(['regular', 'open']),
    requestId: z.string().regex(/^[a-f0-9]{32}$/),
    confirmPaid: z.literal(true),
  })
  .strict();
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
    const run = await submitDiscoveryJob(getDatabasePool(), parsed.data);
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
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get('id'));
  if (!id.success) return Response.json({ error: 'Invalid Run ID.' }, { status: 400 });
  try {
    const run = await getDiscoveryRun(getDatabasePool(), id.data);
    if (!run) return Response.json({ error: 'Run not found.' }, { status: 404 });
    return Response.json(
      { id: run.id, status: run.status, errorSummary: run.errorSummary },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Discovery status failed.', error);
    return Response.json({ error: 'Discovery status unavailable.' }, { status: 500 });
  }
}
