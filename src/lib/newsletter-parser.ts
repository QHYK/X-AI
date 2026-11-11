/** Admin reads collected PostgreSQL mail only. Current parser preview never writes business data. */
import type { Pool } from 'pg';
import { parseMessage } from '../collectors/gmail/mail.js';
import { createPreview, digest } from '../collectors/gmail/preview.js';
import {
  createSourceGuidance,
  isExplicitNewsletterSkip,
  SOURCE_RULE_VERSION,
  type GuidedUnit,
  type LinkEvidence,
} from '../collectors/gmail/source-guided-selection.js';
import { newsletterSource } from '../collectors/gmail/newsletter-source.js';
import { NEWSLETTER_SOURCE_NAMES } from '../collectors/gmail/sources.js';
import {
  getStoredEmail,
  listStoredEmails,
  moduleFingerprint,
  matchExistingModules,
  type StoredEmail,
  type EmailStatus,
} from '../collectors/gmail/email-store.js';
import { newsletterRawArticles } from '../collectors/gmail/adapter.js';
import type { NodeReference } from '../collectors/gmail/html.js';
export const NEWSLETTER_TEMPLATES = Object.keys(NEWSLETTER_SOURCE_NAMES);
export type NewsletterListItem = {
  id: string;
  source: string;
  subject: string | null;
  receivedAt: string | null;
  status: EmailStatus;
};
export type NewsletterParserDetail = {
  id: string;
  source: string;
  subject: string | null;
  receivedAt: string | null;
  collectedAt: string;
  html: string;
  html_sha256: string;
  blocks_sha256: string;
  blocks: NodeReference[];
  links: LinkEvidence[];
  units: GuidedUnit[];
  warnings: string[];
  template: string | null;
  status: EmailStatus;
  importedCount: number;
  storedParserVersion: number | null;
  currentParserVersion: number;
  error: string | null;
  previewError: string | null;
  differsFromImported: boolean | null;
};
const iso = (date: Date | string | null) => (date ? new Date(date).toISOString() : null);
export async function newsletterDetail(
  email: StoredEmail,
  db: Pick<Pool, 'query'>,
): Promise<NewsletterParserDetail> {
  let mail: Awaited<ReturnType<typeof parseMessage>> | null = null,
    previewError: string | null = null;
  try {
    mail = await parseMessage(email.raw_message);
  } catch {
    previewError = '已保存原始 MIME，但当前解码失败。';
  }
  const tooLarge = Boolean(mail?.html && Buffer.byteLength(mail.html, 'utf8') > 2 * 1024 * 1024);
  const preview = createPreview(tooLarge ? '' : (mail?.html ?? ''));
  let units: GuidedUnit[] = [],
    links: LinkEvidence[] = [],
    warnings: string[] = [];
  const source = mail ? newsletterSource(mail) : (email.source_name ?? 'Unknown');
  let differsFromImported: boolean | null = null;
  let template: string | null = null;
  try {
    if (!mail || mail.parseStatus !== 'success' || !mail.html)
      throw new Error(`MIME unavailable: ${mail?.errors.join(',') ?? 'decode_failed'}`);
    if (tooLarge) throw new Error('邮件 HTML 超过 2 MiB，未截断展示。');
    const guidance = createSourceGuidance(mail.html, source, preview, mail.plainText ?? '', {
      subject: mail.subject ?? undefined,
      senderName: mail.from[0]?.name,
    });
    template = guidance.template;
    units = guidance.units;
    links = guidance.links;
    warnings = guidance.warnings;
    if (!NEWSLETTER_TEMPLATES.includes(source)) previewError = '来源尚未支持；可人工标注原文。';
    else if (!units.length && !isExplicitNewsletterSkip(guidance))
      previewError = '当前规则未识别可靠的内容模块；可人工标注原文。';
    if (email.imported_at || email.module_mapping.length) {
      const articles = newsletterRawArticles(mail);
      if (email.module_mapping.length)
        differsFromImported =
          articles.length !== email.module_mapping.length ||
          articles.some(
            (article) =>
              !email.module_mapping.some((m) => m.fingerprint === moduleFingerprint(article)),
          );
      else differsFromImported = articles.length !== 0;
      // Verify actual current Raw content as well as its committed mapping; no persistence from preview.
      if (!differsFromImported && email.module_mapping.length) {
        const existing = (
          await db.query<Parameters<typeof matchExistingModules>[2][number]>(
            `select id,source_id,source_item_origin_id,title,url,content_text,published_at,metadata from raw_articles where id=any($1::uuid[])`,
            [email.module_mapping.map((m) => m.raw_id)],
          )
        ).rows;
        differsFromImported =
          !email.source_id || !matchExistingModules(email.source_id, articles, existing);
      }
    }
  } catch (error) {
    previewError =
      error instanceof Error && (error.message.startsWith('MIME unavailable:') || tooLarge)
        ? error.message
        : '当前 Parser 无法完成解析；原始邮件已保留，可人工标注。';
    if (email.imported_at) differsFromImported = true;
  }
  return {
    id: email.gmail_message_id,
    source,
    subject: email.subject,
    receivedAt: iso(email.received_at),
    collectedAt: iso(email.collected_at)!,
    html: preview.html,
    html_sha256: preview.html_sha256,
    blocks_sha256: digest(JSON.stringify(preview.blocks)),
    blocks: preview.blocks,
    links,
    units,
    warnings,
    template,
    status: email.parse_status,
    importedCount: email.module_mapping.length,
    storedParserVersion: email.parser_version,
    currentParserVersion: SOURCE_RULE_VERSION,
    error: email.error_message ? `${email.error_stage}: ${email.error_message}` : null,
    previewError,
    differsFromImported,
  };
}
export async function serveNewsletterParser(
  request: Request,
  deps: { authenticate: (request: Request) => Promise<Response | null>; database: () => Pool },
) {
  const denied = await deps.authenticate(request);
  if (denied) return denied;
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const url = new URL(request.url),
    id = url.searchParams.get('id'),
    source = url.searchParams.get('source') ?? '',
    status = url.searchParams.get('status') ?? '';
  if (
    (id !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
    source.length > 200 ||
    !['', 'collected', 'success', 'skipped', 'unsupported', 'conflict', 'failed'].includes(status)
  )
    return Response.json({ error: '无效的邮件、来源或状态。' }, { status: 400, headers });
  try {
    const db = deps.database();
    if (id) {
      const email = await getStoredEmail(db, id);
      if (!email) return Response.json({ error: '未找到已采集邮件。' }, { status: 404, headers });
      return Response.json(await newsletterDetail(email, db), { headers });
    }
    const rows = await listStoredEmails(db, source, status);
    const sources = (
      await db.query<{ source: string }>(
        `select distinct coalesce(source_name,'Unknown') as source from newsletter_emails order by source`,
      )
    ).rows.map((r) => r.source);
    return Response.json(
      {
        sources,
        items: rows.map((r) => ({
          id: r.gmail_message_id,
          source: r.source_name ?? 'Unknown',
          subject: r.subject,
          receivedAt: iso(r.received_at),
          status: r.parse_status,
        })),
        perSourceLimit: 5,
      },
      { headers },
    );
  } catch (error) {
    console.error(
      '[newsletter-parser]',
      typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'read_failed',
    );
    return Response.json(
      {
        error:
          (error as { code?: string }).code === '42P01'
            ? '请先部署 0029_newsletter_emails Migration。'
            : '邮件读取失败，请检查数据库及服务器日志。',
      },
      { status: 503, headers },
    );
  }
}
