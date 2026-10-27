import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import {
  MemoryCreateSchema,
  MemoryTypeSchema,
  MemoryUpdateSchema,
} from '@/lib/memory-contracts.js';
import { createMemory, listMemories, updateMemory } from '@/lib/memories.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const parsed = MemoryTypeSchema.optional().safeParse(
    new URL(request.url).searchParams.get('type') ?? undefined,
  );
  if (!parsed.success)
    return Response.json({ error: 'Memory Type 无效。' }, { status: 400, headers });
  try {
    return Response.json(
      { items: await listMemories(getDatabasePool(), parsed.data) },
      { headers },
    );
  } catch (error) {
    console.error('Unable to list memories.', error);
    return Response.json(
      { error: '无法读取 Memory，请检查数据库及 Migration。' },
      { status: 503, headers },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const parsed = MemoryCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: 'Content、Type、Priority 或 Enabled 无效。' },
      { status: 400, headers },
    );
  try {
    return Response.json(
      { item: await createMemory(getDatabasePool(), parsed.data) },
      { status: 201, headers },
    );
  } catch (error) {
    console.error('Unable to create memory.', error);
    return Response.json({ error: 'Memory 创建失败，请重试。' }, { status: 503, headers });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  const parsed = MemoryUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: 'Memory 更新参数无效。' }, { status: 400, headers });
  try {
    const item = await updateMemory(getDatabasePool(), parsed.data);
    return item
      ? Response.json({ item }, { headers })
      : Response.json({ error: 'Memory 不存在。' }, { status: 404, headers });
  } catch (error) {
    console.error('Unable to update memory.', error);
    return Response.json({ error: 'Memory 保存失败，请重试。' }, { status: 503, headers });
  }
}
