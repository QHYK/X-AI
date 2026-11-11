import { getDatabasePool } from '@/db/index.js';
import { adminApiError } from '@/lib/admin-auth.js';
import { parseBriefDate } from '@/lib/brief-date.js';
import { loadEventConsolidationReview } from '@/lib/event-consolidation-review.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const date = parseBriefDate(new URL(request.url).searchParams.get('date'))?.date;
  if (!date) return Response.json({ error: 'date must be YYYY-MM-DD.' }, { status: 400, headers });
  try {
    return Response.json(await loadEventConsolidationReview(getDatabasePool(), date), { headers });
  } catch (error) {
    console.error('Unable to load Event Consolidation Review.', error);
    return Response.json(
      { error: '无法读取 Event Consolidation，请稍后重试。' },
      { status: 500, headers },
    );
  }
}
