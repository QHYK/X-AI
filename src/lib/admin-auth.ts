import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'x_ai_admin';
const SESSION_AGE_SECONDS = 12 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_DIR = process.env.ADMIN_SESSION_DIR
  ? path.resolve(process.env.ADMIN_SESSION_DIR)
  : path.join(
      os.tmpdir(),
      `x-ai-field-admin-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)}`,
    );
const attempts: number[] = [];

function passwordConfig(): { salt: Buffer; hash: Buffer; fingerprint: string } | null {
  const value = process.env.ADMIN_PASSWORD_HASH;
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(value ?? '');
  if (!match) return null;
  return {
    salt: Buffer.from(match[1], 'hex'),
    hash: Buffer.from(match[2], 'hex'),
    fingerprint: createHash('sha256').update(value!).digest('hex'),
  };
}

export function authConfigured(): boolean {
  return (
    passwordConfig() !== null && ['true', 'false'].includes(process.env.ADMIN_COOKIE_SECURE ?? '')
  );
}

export async function createAdminPasswordHash(
  password: string,
  salt = randomBytes(16),
): Promise<string> {
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const config = passwordConfig();
  if (!config || !authConfigured() || password.length > 1024) return false;
  const candidate = (await scrypt(password, config.salt, config.hash.length)) as Buffer;
  return timingSafeEqual(candidate, config.hash);
}

/** A small, process-local global limit that does not trust spoofable forwarded IP headers. */
export function allowLoginAttempt(now = Date.now()): boolean {
  while (attempts.length && attempts[0]! <= now - 60_000) attempts.shift();
  if (attempts.length >= 10) return false;
  attempts.push(now);
  return true;
}

function tokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  const entry = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = entry?.slice(COOKIE_NAME.length + 1) ?? '';
  return TOKEN_PATTERN.test(token) ? token : null;
}

function sessionPath(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex');
  return path.join(SESSION_DIR, digest);
}

export async function hasAdminSession(request: Request, now = Date.now()): Promise<boolean> {
  const config = passwordConfig();
  if (!config || !authConfigured()) return false;
  const token = tokenFromRequest(request);
  if (!token) return false;
  try {
    const record: unknown = JSON.parse(await readFile(sessionPath(token), 'utf8'));
    if (!record || typeof record !== 'object') return false;
    const session = record as { expiresAt?: unknown; fingerprint?: unknown };
    return (
      typeof session.expiresAt === 'number' &&
      session.expiresAt > now &&
      session.fingerprint === config.fingerprint
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    console.error('Unable to validate admin session.', error);
    return false;
  }
}

export async function createAdminSession(now = Date.now()): Promise<string> {
  const config = passwordConfig();
  if (!config || !authConfigured()) throw new Error('Admin authentication is not configured.');
  const token = randomBytes(32).toString('base64url');
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  await writeFile(
    sessionPath(token),
    JSON.stringify({
      expiresAt: now + SESSION_AGE_SECONDS * 1000,
      fingerprint: config.fingerprint,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return token;
}

export async function revokeAdminSession(request: Request): Promise<void> {
  const token = tokenFromRequest(request);
  if (!token) return;
  try {
    await unlink(sessionPath(token));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function sessionCookie(token: string, maxAge = SESSION_AGE_SECONDS): string {
  const secure = process.env.ADMIN_COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/ai; Max-Age=${maxAge}${secure}`;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const requestUrl = new URL(request.url);
  // Next may use an internal hostname in Request.url. Host is the browser's target authority;
  // do not trust X-Forwarded-Host supplied by an arbitrary client.
  const host = request.headers.get('host') ?? requestUrl.host;
  return origin === `${requestUrl.protocol}//${host}`;
}

export async function adminApiError(request: Request): Promise<Response | null> {
  if (!(await hasAdminSession(request)))
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  return null;
}
