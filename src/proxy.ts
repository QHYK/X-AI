// this + 服务端认证：负责后台访问控制
import { NextRequest, NextResponse } from 'next/server.js';
import { adminApiError, hasAdminSession } from './lib/admin-auth.js';

export async function proxy(request: NextRequest) {
  const basePath = request.nextUrl.basePath;
  const pathname = request.nextUrl.pathname;
  if (pathname === '/login') {
    return (await hasAdminSession(request))
      ? NextResponse.redirect(new URL(`${basePath}/dashboard`, request.url))
      : NextResponse.next();
  }
  if (pathname.startsWith('/api/admin/')) {
    return (await adminApiError(request)) ?? NextResponse.next();
  }
  if (await hasAdminSession(request)) return NextResponse.next();
  return NextResponse.redirect(new URL(`${basePath}/login`, request.url));
}

export const config = {
  matcher: [
    '/login',
    '/dashboard/:path*',
    '/review/:path*',
    '/prompts/:path*',
    '/api/admin/:path*',
  ],
};
