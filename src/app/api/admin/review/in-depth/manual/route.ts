import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { createManualInDepthCandidate } from '@/lib/manual-in-depth.js';
import { getInDepthReviewItem } from '@/lib/in-depth-reads.js';
import { readStoredArticle } from '@/lib/article-fetch-cache.js';
import { IntroductionError } from '@/lib/in-depth-introduction.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return Response.json({ error: 'Expected JSON.' }, { status: 400 });
  try {
    const result = await createManualInDepthCandidate(getDatabasePool(), await request.json());
    return Response.json(result, {
      status: result.existing ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { error: '请输入有效 HTTP(S) URL 和最多三组完整双语 Tags。' },
        { status: 400 },
      );
    if (error instanceof IntroductionError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error('Manual In-depth submission failed.', error);
    return Response.json(
      { error: '候选获取或保存失败，请检查抓取服务及数据库。' },
      { status: 503 },
    );
  }
}

/** Admin-only, on-demand saved content preview; never fetches a URL. */
export async function GET(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get('id'));
  if (!id.success) return Response.json({ error: 'Invalid candidate ID.' }, { status: 400 });
  try {
    const db = getDatabasePool();
    const item = await getInDepthReviewItem(db, id.data);
    if (!item) return Response.json({ error: 'Candidate not found.' }, { status: 404 });
    const contentUrl =
      typeof item.evidence?.contentUrl === 'string' ? item.evidence.contentUrl : item.url;
    const article = await readStoredArticle(db, contentUrl);
    return Response.json(
      { content: article?.markdown ?? null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Saved In-depth content preview failed.', error);
    return Response.json({ error: '正文读取失败。' }, { status: 503 });
  }
}
