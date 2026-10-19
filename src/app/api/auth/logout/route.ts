import { revokeAdminSession, sameOrigin, sessionCookie } from '@/lib/admin-auth.js';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  try {
    await revokeAdminSession(request);
    return Response.json(
      { status: 'signed_out' },
      {
        headers: { 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    console.error('Unable to revoke admin session.', error);
    return Response.json({ error: 'Logout unavailable.' }, { status: 503 });
  }
}
