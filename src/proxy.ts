import { NextResponse } from 'next/server.js';
import { canAccessInDepthReview } from './lib/in-depth-review-access.js';

/** Protect the review page and its API before either can read or write data. */
export function proxy() {
  if (canAccessInDepthReview()) return NextResponse.next();
  return new NextResponse('In-depth Review is unavailable without admin authentication.', {
    status: 403,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const config = {
  matcher: ['/review/in-depth/:path*', '/api/review/in-depth/:path*'],
};
