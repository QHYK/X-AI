import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { putBackIgnoredArticle, PutBackError } from '@/lib/digest-put-back.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return Response.json({ message: 'Expected JSON.' }, { status: 400 });
  try {
    const restored = await putBackIgnoredArticle(getDatabasePool(), await request.json());
    return Response.json({ restored }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json({ message: 'Invalid article ID or Daily date.' }, { status: 400 });
    if (error instanceof PutBackError)
      return Response.json(
        { message: error.message, generatedFields: error.generatedFields },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    console.error('Ignored article Put Back failed.', error);
    return Response.json({ message: '恢复失败，请检查数据库连接。' }, { status: 503 });
  }
}
