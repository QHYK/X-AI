import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server.js';

const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'x-ai-admin-auth-'));
process.env.ADMIN_SESSION_DIR = sessionDir;
process.env.ADMIN_COOKIE_SECURE = 'false';
delete process.env.ADMIN_PASSWORD_HASH;

const auth = await import('../src/lib/admin-auth.js');
const { POST: login } = await import('../src/app/api/auth/login/route.js');
const { POST: logout } = await import('../src/app/api/auth/logout/route.js');
const { config, proxy } = await import('../src/proxy.js');
const origin = 'http://localhost:3000';
const password = 'long-test-admin-password';
const url = `${origin}/ai/api/auth/login`;

try {
  assert.equal(
    auth.sameOrigin(
      new Request('http://localhost:5279/ai/api/auth/login', {
        headers: { host: '127.0.0.1:5279', origin: 'http://127.0.0.1:5279' },
      }),
    ),
    true,
  );
  assert.equal(
    auth.sameOrigin(
      new Request('http://localhost:5279/ai/api/auth/login', {
        headers: {
          host: '127.0.0.1:5279',
          origin: 'http://evil.test',
          'x-forwarded-host': 'evil.test',
        },
      }),
    ),
    false,
  );
  const missingConfig = await proxy(
    new NextRequest(`${origin}/ai/dashboard`, { nextConfig: { basePath: '/ai' } }),
  );
  assert.equal(missingConfig.status, 307);
  assert.equal(missingConfig.headers.get('location'), `${origin}/ai/login`);
  assert.equal(await auth.hasAdminSession(new Request(url)), false);

  process.env.ADMIN_PASSWORD_HASH = await auth.createAdminPasswordHash(password);
  const wrong = await login(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    }),
  );
  assert.equal(wrong.status, 401);
  const valid = await login(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );
  assert.equal(valid.status, 200);
  const setCookie = valid.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly; SameSite=Lax; Path=\/ai; Max-Age=43200/);
  assert.doesNotMatch(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0]!;
  const authorized = new Request(`${origin}/ai/api/admin/evaluation`, { headers: { cookie } });
  assert.equal(await auth.hasAdminSession(authorized), true);
  assert.equal(await auth.adminApiError(authorized), null);
  assert.equal(
    (
      await auth.adminApiError(
        new Request(authorized.url, {
          method: 'POST',
          headers: { cookie, origin: 'http://evil.test' },
        }),
      )
    )?.status,
    403,
  );
  assert.equal(await auth.hasAdminSession(authorized, Date.now() + 13 * 60 * 60 * 1000), false);
  assert.equal(
    await auth.hasAdminSession(
      new Request(authorized.url, {
        headers: { cookie: `${cookie.slice(0, -1)}x` },
      }),
    ),
    false,
  );

  for (const page of [
    '/dashboard',
    '/dashboard/analytics',
    '/dashboard/metrics',
    '/review/events',
    '/review/long-form',
    '/review/in-depth',
    '/review/models',
  ]) {
    const request = new NextRequest(`${origin}/ai${page}`, { nextConfig: { basePath: '/ai' } });
    assert.equal((await proxy(request)).headers.get('location'), `${origin}/ai/login`, page);
    const authed = new NextRequest(`${origin}/ai${page}`, {
      headers: { cookie },
      nextConfig: { basePath: '/ai' },
    });
    assert.equal((await proxy(authed)).status, 200, page);
  }
  const loginPage = new NextRequest(`${origin}/ai/login`, {
    headers: { cookie },
    nextConfig: { basePath: '/ai' },
  });
  assert.equal((await proxy(loginPage)).headers.get('location'), `${origin}/ai/dashboard`);
  const anonymousApi = await proxy(
    new NextRequest(`${origin}/ai/api/admin/evaluation`, { nextConfig: { basePath: '/ai' } }),
  );
  assert.equal(anonymousApi.status, 401);
  assert.match(anonymousApi.headers.get('content-type') ?? '', /application\/json/);

  const routes: Array<[string, string[]]> = [
    ['dashboard/analytics/daily-volume', ['GET']],
    ['dashboard/analytics/ignored-articles', ['GET']],
    ['dashboard/analytics/source-days', ['GET']],
    ['dashboard/analytics/sources', ['GET']],
    ['dashboard/daily/retry', ['POST']],
    ['dashboard/step/retry', ['GET', 'POST']],
    ['discovery', ['GET', 'POST']],
    ['review/events', ['GET']],
    ['review/events/ranking', ['PATCH']],
    ['review/long-form', ['GET']],
    ['review/long-form/ranking', ['PATCH']],
    ['review/in-depth', ['GET', 'PATCH', 'POST']],
    ['evaluation', ['GET']],
    ['evaluation/run', ['POST']],
    ['evaluation/cancel', ['POST']],
  ];
  for (const [route, methods] of routes) {
    assert.equal(
      existsSync(path.join(process.cwd(), 'src/app/api', route, 'route.ts')),
      false,
      route,
    );
    const handler = await import(`../src/app/api/admin/${route}/route.js`);
    for (const method of methods) {
      const request = new Request(`${origin}/ai/api/admin/${route}`, { method });
      assert.equal((await handler[method](request)).status, 401, `${method} ${route}`);
    }
  }
  const inDepth = await import('../src/app/api/admin/review/in-depth/route.js');
  const discovery = await import('../src/app/api/admin/discovery/route.js');
  assert.equal(
    (
      await discovery.POST(
        new Request(`${origin}/ai/api/admin/discovery`, {
          method: 'POST',
          headers: { cookie, origin: 'http://evil.test' },
          body: '{}',
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await discovery.POST(
        new Request(`${origin}/ai/api/admin/discovery`, {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            date: '2026-10-19',
            mode: 'regular',
            requestId: 'a'.repeat(32),
            confirmPaid: false,
          }),
        }),
      )
    ).status,
    400,
  );
  for (const method of ['POST', 'PATCH'] as const) {
    assert.equal(
      (
        await inDepth[method](
          new Request(`${origin}/ai/api/admin/review/in-depth`, {
            method,
            headers: { cookie, origin: 'http://evil.test', 'content-type': 'application/json' },
            body: '{}',
          }),
        )
      ).status,
      403,
    );
  }
  const evaluation = await import('../src/app/api/admin/evaluation/route.js');
  assert.equal(
    (
      await evaluation.GET(
        new Request(`${origin}/ai/api/admin/evaluation`, { headers: { cookie } }),
      )
    ).status,
    400,
  );
  const dailyRetry = await import('../src/app/api/admin/dashboard/daily/retry/route.js');
  assert.equal(
    (
      await dailyRetry.POST(
        new Request(`${origin}/ai/api/admin/dashboard/daily/retry`, {
          method: 'POST',
          headers: { cookie, origin: 'http://evil.test' },
        }),
      )
    ).status,
    403,
  );
  assert.equal(config.matcher.includes('/api/admin/:path*'), true);
  assert.equal(config.matcher.includes('/api/brief/:path*'), false);
  for (const publicPath of [
    'src/app/page.tsx',
    'src/app/api/in-depth/route.ts',
    'src/app/api/brief/route.ts',
    'src/app/api/content/read-more/route.ts',
  ]) {
    assert.equal(existsSync(path.join(process.cwd(), publicPath)), true, publicPath);
  }
  assert.equal(existsSync(path.join(process.cwd(), 'src/app/in-depth/page.tsx')), false);
  const browserPaths: Array<[string, string, string]> = [
    ['/ai/dashboard', './api/admin/dashboard/daily/retry', '/ai/api/admin/dashboard/daily/retry'],
    ['/ai/dashboard', './api/admin/dashboard/step/retry', '/ai/api/admin/dashboard/step/retry'],
    [
      '/ai/dashboard/analytics',
      '../api/admin/dashboard/analytics/sources',
      '/ai/api/admin/dashboard/analytics/sources',
    ],
    [
      '/ai/review/events',
      '../api/admin/review/events/ranking',
      '/ai/api/admin/review/events/ranking',
    ],
    [
      '/ai/review/long-form',
      '../api/admin/review/long-form/ranking',
      '/ai/api/admin/review/long-form/ranking',
    ],
    ['/ai/review/models', '../api/admin/evaluation', '/ai/api/admin/evaluation'],
    ['/ai/login', './api/auth/login', '/ai/api/auth/login'],
    ['/ai/dashboard/metrics', '../api/auth/logout', '/ai/api/auth/logout'],
  ];
  for (const [page, relative, expected] of browserPaths) {
    assert.equal(new URL(relative, `${origin}${page}`).pathname, expected);
  }

  const signedOut = await logout(
    new Request(`${origin}/ai/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin },
    }),
  );
  assert.equal(signedOut.status, 200);
  assert.equal(await auth.hasAdminSession(authorized), false);
  process.env.ADMIN_COOKIE_SECURE = 'true';
  assert.match(auth.sessionCookie('example'), /; Secure$/);
  const limitWindow = Date.now() + 60 * 60 * 1000;
  for (let index = 0; index < 10; index++) assert.equal(auth.allowLoginAttempt(limitWindow), true);
  assert.equal(auth.allowLoginAttempt(limitWindow), false);
} finally {
  for (const file of await readdir(sessionDir)) await unlink(path.join(sessionDir, file));
  await rmdir(sessionDir);
}

console.log('Admin authentication tests passed.');
