import { getDatabasePool } from '@/db/index.js';
import { getPublishedInDepthPage } from '@/lib/in-depth-reads.js';
import { decodeInDepthCursor } from '@/lib/in-depth-pagination.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<Response> {
  let cursor;
  try {
    cursor = decodeInDepthCursor(request ? new URL(request.url).searchParams.get('cursor') : null);
  } catch {
    return Response.json({ error: 'Invalid In-depth cursor.' }, { status: 400 });
  }
  try {
    const page = await getPublishedInDepthPage(getDatabasePool(), cursor);
    return Response.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to load published In-depth Reads.', error);
    return Response.json({ error: 'Failed to load In-depth Reads.' }, { status: 500 });
  }
}
