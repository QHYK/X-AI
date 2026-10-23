import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { listPromptRegistries } from '@/lib/prompts/registry.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Query = z.object({
  q: z.string().max(200),
  kind: z.enum(['request', 'fragment']).optional(),
});
export async function GET(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const parsed = Query.safeParse({
    q: params.get('q') ?? '',
    kind: params.get('kind') || undefined,
  });
  if (!parsed.success) return Response.json({ error: '搜索条件无效。' }, { status: 400 });
  try {
    const items = await listPromptRegistries(getDatabasePool(), parsed.data.q, parsed.data.kind);
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Unable to list Prompt Registries.', error);
    return Response.json(
      { error: '无法读取 Prompt 列表，请检查数据库连接及基线导入状态。' },
      { status: 503 },
    );
  }
}
