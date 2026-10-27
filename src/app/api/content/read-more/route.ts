/** 按需生成单篇 Digest / Long-form 的中文详细总结。 */
import { getDatabasePool } from '@/db/index.js';
import { generateReadMoreSummary } from '@/lib/read-more.js';
import { ReadMoreWaitTimeoutError } from '@/lib/read-more-singleflight.js';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const headers = corsHeaders(request);
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON.' }, { status: 400, headers });
  }

  if (!isReadMoreRequest(body)) {
    return jsonResponse({ error: 'contentId must be a UUID string.' }, { status: 400, headers });
  }

  try {
    const result = await generateReadMoreSummary(getDatabasePool(), body.contentId);
    return jsonResponse(result, { headers });
  } catch (error) {
    console.error('Failed to generate Read More summary.', error);
    return jsonResponse(
      {
        status: 'temporarily_unavailable',
        ...(error instanceof ReadMoreWaitTimeoutError ? { reason: 'generation_wait_timeout' } : {}),
      },
      { headers },
    );
  }
}

export function OPTIONS(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function isReadMoreRequest(value: unknown): value is { contentId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'contentId' in value &&
    typeof value.contentId === 'string' &&
    UUID_PATTERN.test(value.contentId.trim())
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function corsHeaders(request: Request): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  const origin = request.headers.get('origin');

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = (process.env.BRIEF_API_ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins.includes(origin);
  }

  return /^http:\/\/localhost:\d+$/.test(origin);
}

function jsonResponse(
  body: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
