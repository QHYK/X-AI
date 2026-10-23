import { z } from 'zod';
import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import { PROMPT_CONTRACTS, FRAGMENT_KEYS, PromptBodySchema } from '@/lib/prompts/contracts.js';
import {
  getPromptManagementDetail,
  createPromptDraftFromVersion,
  updatePromptDraft,
  publishPromptVersion,
  activatePromptVersion,
  PromptManagementError,
} from '@/lib/prompts/registry.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Key = z.enum([
  ...(Object.keys(PROMPT_CONTRACTS) as (keyof typeof PROMPT_CONTRACTS)[]),
  ...FRAGMENT_KEYS,
]);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Save = z.object({ versionId: z.uuid(), expectedHash: Hash, body: PromptBodySchema }).strict();
const Action = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('createDraft'), sourceVersionId: z.uuid(), expectedHash: Hash })
    .strict(),
  z.object({ action: z.literal('publish'), versionId: z.uuid(), expectedHash: Hash }).strict(),
  z
    .object({
      action: z.literal('activate'),
      versionId: z.uuid(),
      expectedActiveVersionId: z.uuid().nullable(),
    })
    .strict(),
]);
type Context = { params: Promise<{ key: string }> };
async function handle(request: Request, context: Context): Promise<Response> {
  const denied = await adminApiError(request);
  if (denied) return denied;
  try {
    const key = Key.parse((await context.params).key);
    if (request.method === 'GET')
      return Response.json(await getPromptManagementDetail(getDatabasePool(), key), {
        headers: { 'Cache-Control': 'no-store' },
      });
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return Response.json({ error: 'Expected application/json.' }, { status: 415 });
    const input: unknown = await request.json();
    const db = getDatabasePool();
    if (request.method === 'PATCH') {
      const data = Save.parse(input);
      return Response.json(
        { version: await updatePromptDraft(db, key, data.versionId, data.expectedHash, data.body) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const data = Action.parse(input);
    const version =
      data.action === 'createDraft'
        ? await createPromptDraftFromVersion(db, key, data.sourceVersionId, data.expectedHash)
        : data.action === 'publish'
          ? await publishPromptVersion(db, key, data.versionId, data.expectedHash)
          : await activatePromptVersion(db, key, data.versionId, data.expectedActiveVersionId);
    return Response.json(
      { version },
      {
        status: data.action === 'createDraft' ? 201 : 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    if (error instanceof PromptManagementError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { error: '请求格式无效，请检查 Key、版本标识、模板结构及 Fragment 引用。' },
        { status: 400 },
      );
    const code = (error as { code?: string }).code;
    if (code === '23505')
      return Response.json({ error: '版本发生冲突，请刷新后重新检查。' }, { status: 409 });
    // Contract validation uses plain Errors; its messages contain schema rules, never prompt contents.
    const message = error instanceof Error ? error.message : '';
    const validation =
      /^(Unknown |Unsupported |Only |Fragments |Fragment |Duplicate |Request must reference|Imported fragment|Expected |Invalid published fragment|Missing |Active must|Shared fragments|Reference must)/;
    if (validation.test(message) || ['23514', '23503', 'P0001'].includes(code ?? ''))
      return Response.json(
        { error: `校验失败：${code ? '数据库拒绝了无效的版本或引用。' : message}` },
        { status: 400 },
      );
    console.error('Prompt management request failed.', error);
    return Response.json(
      { error: '操作未能确认，请检查数据库并刷新核实；当前编辑内容已保留。' },
      { status: 503 },
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
