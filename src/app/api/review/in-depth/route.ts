import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDatabasePool } from '@/db/index.js';
import { canAccessInDepthReview } from '@/lib/in-depth-review-access.js';
import {
  getInDepthReviewItem,
  InDepthReviewStatusSchema,
  listInDepthReviewItems,
  parseInDepthReviewUpdate,
  updateInDepthReviewItem,
} from '@/lib/in-depth-reads.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function accessError(): Response | null {
  if (canAccessInDepthReview()) return null;
  return Response.json(
    { error: 'In-depth Review requires admin authentication.' },
    { status: 403 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const denied = accessError();
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  try {
    if (id) {
      if (!z.uuid().safeParse(id).success) {
        return Response.json({ error: 'Invalid candidate ID.' }, { status: 400 });
      }
      const item = await getInDepthReviewItem(getDatabasePool(), id);
      return item
        ? Response.json({ item }, { headers: { 'Cache-Control': 'no-store' } })
        : Response.json({ error: 'Candidate not found.' }, { status: 404 });
    }
    const status = InDepthReviewStatusSchema.safeParse(params.get('status') ?? 'pending');
    if (!status.success) {
      return Response.json({ error: 'Invalid review status.' }, { status: 400 });
    }
    const items = await listInDepthReviewItems(getDatabasePool(), status.data);
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to load In-depth Review.', error);
    return Response.json({ error: 'Failed to load In-depth Review.' }, { status: 500 });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const denied = accessError();
  if (denied) return denied;
  if (
    request.headers.get('origin') !== new URL(request.url).origin ||
    !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')
  ) {
    return Response.json({ error: 'Invalid request origin or content type.' }, { status: 403 });
  }
  let input: ReturnType<typeof parseInDepthReviewUpdate>;
  try {
    input = parseInDepthReviewUpdate(await request.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? 'Invalid review fields.' : 'Invalid JSON body.' },
      { status: 400 },
    );
  }
  try {
    const item = await updateInDepthReviewItem(getDatabasePool(), input);
    if (!item) return Response.json({ error: 'Candidate not found.' }, { status: 404 });
    revalidatePath('/in-depth');
    revalidatePath('/review/in-depth');
    return Response.json({ item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to save In-depth Review.', error);
    return Response.json({ error: 'Failed to save In-depth Review.' }, { status: 500 });
  }
}
