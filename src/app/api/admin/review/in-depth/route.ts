import {
  generateAndSaveInDepthIntroduction,
  IntroductionError,
} from '@/lib/in-depth-introduction.js';
import { adminApiError } from '@/lib/admin-auth.js';
import { generateManualInDepthIntroduction } from '@/lib/manual-in-depth.js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDatabasePool } from '@/db/index.js';
import {
  getInDepthReviewItem,
  InDepthReviewStatusSchema,
  listInDepthReviewItems,
  parseInDepthReviewUpdate,
  updateInDepthReviewItem,
} from '@/lib/in-depth-reads.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const authError = await adminApiError(request);
  if (authError) return authError;
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
  const authError = await adminApiError(request);
  if (authError) return authError;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
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
    revalidatePath('/review/in-depth');
    return Response.json({ item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to save In-depth Review.', error);
    return Response.json({ error: 'Failed to save In-depth Review.' }, { status: 500 });
  }
}

/** Auth and origin checks happen before DB access or any potentially paid request. */
export async function POST(request: Request): Promise<Response> {
  const authError = await adminApiError(request);
  if (authError) return authError;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return Response.json({ error: 'Expected JSON.' }, { status: 400 });
  let input: { id: string; regenerate?: boolean };
  try {
    input = z
      .object({ id: z.uuid(), regenerate: z.boolean().optional() })
      .strict()
      .parse(await request.json());
  } catch {
    return Response.json({ error: 'Invalid candidate ID or JSON body.' }, { status: 400 });
  }
  try {
    const db = getDatabasePool();
    const item = await getInDepthReviewItem(db, input.id);
    if (!item) return Response.json({ error: 'Candidate not found.' }, { status: 404 });
    const manual = item.discoveryPath === 'manual';
    const introduction = manual
      ? await generateManualInDepthIntroduction(db, input.id, { regenerate: input.regenerate })
      : await generateAndSaveInDepthIntroduction(db, input.id);
    revalidatePath('/review/in-depth');
    return Response.json(
      {
        introduction,
        saved: true,
        ...(manual ? { item: await getInDepthReviewItem(db, input.id) } : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof IntroductionError)
      return Response.json(
        { error: error.message, introduction: error.introduction, saved: false },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    console.error('Failed to generate In-depth introduction.', error);
    return Response.json({ error: 'Failed to generate introduction.' }, { status: 500 });
  }
}
