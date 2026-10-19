import {
  allowLoginAttempt,
  authConfigured,
  createAdminSession,
  sameOrigin,
  sessionCookie,
  verifyAdminPassword,
} from '@/lib/admin-auth.js';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (!allowLoginAttempt())
    return Response.json(
      { error: 'Too many login attempts.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  let password: unknown;
  try {
    password = ((await request.json()) as { password?: unknown }).password;
  } catch {
    return Response.json({ error: 'Invalid credentials.' }, { status: 401 });
  }
  if (!authConfigured() || typeof password !== 'string' || !(await verifyAdminPassword(password))) {
    return Response.json({ error: 'Invalid credentials.' }, { status: 401 });
  }
  try {
    const token = await createAdminSession();
    return Response.json(
      { status: 'authenticated' },
      {
        headers: { 'Set-Cookie': sessionCookie(token), 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    console.error('Unable to create admin session.', error);
    return Response.json({ error: 'Login unavailable.' }, { status: 503 });
  }
}
