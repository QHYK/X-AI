import { getDatabasePool } from '@/db/index.js';
import { listPublishedInDepthReads, toPublicInDepthRead } from '@/lib/in-depth-reads.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const items = await listPublishedInDepthReads(getDatabasePool());
    return Response.json(
      { items: items.map(toPublicInDepthRead) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Failed to load published In-depth Reads.', error);
    return Response.json({ error: 'Failed to load In-depth Reads.' }, { status: 500 });
  }
}
