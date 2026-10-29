import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from '@/db/index.js';
import {
  listRuntimeFiles,
  readRuntimeFile,
  resolveRuntimeDirectory,
  RuntimeFileError,
} from '@/lib/dashboard-runtime.js';

export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  const authError = await adminApiError(request);
  if (authError) return authError;
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const params = new URL(request.url).searchParams;
    const directory = await resolveRuntimeDirectory(getDatabasePool(), params.get('runId') ?? '');
    const child = params.get('path') ?? '';
    return Response.json(
      params.get('file') === '1'
        ? { content: await readRuntimeFile(directory, child) }
        : { directory, entries: await listRuntimeFiles(directory, child) },
      { headers },
    );
  } catch (error) {
    if (error instanceof RuntimeFileError)
      return Response.json({ message: error.message }, { status: error.status, headers });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return Response.json(
        { message: 'Runtime directory or file does not exist on this server.' },
        { status: 404, headers },
      );
    console.error('Failed to read Dashboard Runtime files.', error);
    return Response.json({ message: 'Unable to read Runtime files.' }, { status: 500, headers });
  }
}
