import { getDatabasePool } from '@/db/index.js';
import { adminApiError } from '@/lib/admin-auth.js';
import { serveNewsletterParser } from '@/lib/newsletter-parser.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  return serveNewsletterParser(request, { authenticate: adminApiError, database: getDatabasePool });
}
