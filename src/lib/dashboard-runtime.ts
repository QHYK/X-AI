import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';

const ROOTS: Record<string, string> = {
  content_completion: 'content-completion',
  exact_duplicate_filter: 'pre-stage1-duplicates',
  stage1: 'stage1',
  stage2: 'stage2',
  stage3: 'stage3',
  stage4: 'stage4',
};
const EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.log', '.md']);
export const RUNTIME_FILE_LIMIT = 1024 * 1024;
export class RuntimeFileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type RuntimeEntry = { name: string; path: string; directory: boolean };

function childPath(value: string): string {
  if (
    value.length > 1024 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.')) ||
    value.split('/').length > 12
  )
    throw new RuntimeFileError('Invalid Runtime path.');
  return value;
}

/** Only the exact persisted attempt is resolved; never scan for the latest directory. */
export async function resolveRuntimeDirectory(pool: Pool, runId: string): Promise<string> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) {
    throw new RuntimeFileError('Invalid Run ID.');
  }
  const result = await pool.query<{
    step: string;
    status: string;
    started_at: Date | string;
    metrics: { runtime_dir?: unknown };
  }>('select step, status, started_at, metrics from pipeline_runs where id=$1::uuid', [runId]);
  const row = result.rows[0];
  if (!row || !ROOTS[row.step]) throw new RuntimeFileError('Runtime attempt not found.', 404);
  if (row.status === 'success')
    throw new RuntimeFileError('Runtime viewer is available for non-success attempts only.', 403);
  let directory = row.metrics?.runtime_dir;
  if (
    directory == null &&
    ['content_completion', 'exact_duplicate_filter', 'stage1', 'stage2'].includes(row.step)
  ) {
    // These writers use the same Date for the DB start and directory name. No tolerance window.
    const collision = await pool.query<{ count: string }>(
      'select count(*)::text as count from pipeline_runs where step=$1 and started_at=$2::timestamptz',
      [row.step, new Date(row.started_at).toISOString()],
    );
    if (collision.rows[0]?.count === '1') {
      directory = `runtime/${ROOTS[row.step]}/${new Date(row.started_at).toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
    }
  }
  if (typeof directory !== 'string')
    throw new RuntimeFileError('No reliable Runtime mapping for this historical attempt.', 404);
  childPath(directory);
  if (!new RegExp(`^runtime/${ROOTS[row.step]}/[0-9TZ-]+$`).test(directory)) {
    throw new RuntimeFileError('Invalid recorded Runtime directory.');
  }
  return directory;
}

async function safePath(root: string, directory: string, child: string): Promise<string> {
  childPath(directory);
  childPath(child);
  const base = await realpath(resolve(root));
  const parts = [directory, child].filter(Boolean).join('/').split('/');
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new RuntimeFileError('Symbolic links are not accessible.', 403);
  }
  const canonical = await realpath(current);
  const inside = relative(base, canonical);
  if (!inside || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new RuntimeFileError('Invalid Runtime path.');
  return canonical;
}

export async function listRuntimeFiles(
  directory: string,
  child = '',
  root = process.cwd(),
): Promise<RuntimeEntry[]> {
  const location = await safePath(root, directory, child);
  const entries = await readdir(location, { withFileTypes: true });
  if (entries.length > 500) throw new RuntimeFileError('Directory has too many entries.', 413);
  return entries
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        (entry.isDirectory() ||
          (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase()))),
    )
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .map((entry) => ({
      name: entry.name,
      path: [child, entry.name].filter(Boolean).join('/'),
      directory: entry.isDirectory(),
    }));
}

function redactText(text: string): string {
  return text
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/"']+:[^\s@"']+@/gi, '[REDACTED CONNECTION]@')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|password|secret|authorization|cookie|database_url|access[_-]?token|refresh[_-]?token)["']?\s*[=:]\s*)[^\r\n]+/gi,
      '$1[REDACTED]',
    );
}
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:.*(?:password|secret|api[_-]?key)|authorization|cookie|.*_token|database_url|connectionString|token)$/i.test(
          key,
        )
          ? '[REDACTED]'
          : redact(item),
      ]),
    );
  return value;
}
export async function readRuntimeFile(
  directory: string,
  child: string,
  root = process.cwd(),
): Promise<string> {
  if (!child || !EXTENSIONS.has(extname(child).toLowerCase()))
    throw new RuntimeFileError('Unsupported file type.');
  const location = await safePath(root, directory, child);
  const handle = await open(
    location,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RuntimeFileError('Not a regular file.');
    if (info.size > RUNTIME_FILE_LIMIT)
      throw new RuntimeFileError('File exceeds the 1 MiB preview limit.', 413);
    const buffer = Buffer.alloc(RUNTIME_FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > RUNTIME_FILE_LIMIT)
      throw new RuntimeFileError('File exceeds the 1 MiB preview limit.', 413);
    const text = buffer.subarray(0, length).toString('utf8');
    if (extname(child).toLowerCase() === '.json') {
      try {
        return JSON.stringify(redact(JSON.parse(text)), null, 2);
      } catch {
        /* Invalid JSON remains readable. */
      }
    }
    return text
      .split('\n')
      .map((line) => {
        try {
          return JSON.stringify(redact(JSON.parse(line)));
        } catch {
          return redactText(line);
        }
      })
      .join('\n');
  } finally {
    await handle.close();
  }
}
