import { simpleParser } from 'mailparser';
import { JSDOM } from 'jsdom';
import { z } from 'zod';

const Header = z.object({ name: z.string(), value: z.string() });
export type MimePart = {
  mimeType?: string;
  filename?: string;
  headers?: z.infer<typeof Header>[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: MimePart[];
};
const Part: z.ZodType<MimePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(Header).optional(),
    body: z
      .object({
        data: z.string().optional(),
        size: z.number().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(Part).optional(),
  }),
);
export const Message = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  threadId: z.string().optional(),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: Part,
});
export type GmailMessage = z.infer<typeof Message>;
const parserOptions = { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true };

export function header(part: MimePart, name: string) {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function parseMessage(raw: unknown) {
  const message = Message.parse(raw);
  const payload = message.payload;
  // Only feed headers to MailParser here; attachments are never fetched or passed to it.
  const envelope = await simpleParser(
    `${(payload.headers ?? [])
      .map(
        ({ name, value }) => `${name.replace(/[\r\n:]/g, '')}: ${value.replace(/[\r\n]+/g, ' ')}`,
      )
      .join('\r\n')}\r\n\r\n`,
    parserOptions,
  );
  const html: string[] = [];
  const plain: string[] = [];
  const mimeTypes: Record<string, number> = {};
  const errors: string[] = [];
  let unavailableBodies = 0;
  let ignoredAttachments = 0;
  let textParts = 0;
  async function walk(part: MimePart, depth = 0): Promise<void> {
    if (depth > 40) {
      errors.push('mime_nesting_limit');
      return;
    }
    const mime = (part.mimeType ?? 'unknown').toLowerCase();
    mimeTypes[mime] = (mimeTypes[mime] ?? 0) + 1;
    if (
      part.filename ||
      /^attachment\b/i.test(header(part, 'content-disposition') ?? '') ||
      mime === 'message/rfc822'
    ) {
      ignoredAttachments++;
      return;
    }
    if (mime.startsWith('multipart/')) {
      for (const child of part.parts ?? []) await walk(child, depth + 1);
      return;
    }
    if (mime !== 'text/html' && mime !== 'text/plain') {
      ignoredAttachments++;
      return;
    }
    textParts++;
    const data = part.body?.data;
    if (!data) {
      if (part.body?.attachmentId || (part.body?.size ?? 0) > 0) unavailableBodies++;
      return;
    }
    try {
      if (!/^[a-zA-Z0-9_-]*={0,2}$/.test(data) || data.replace(/=+$/, '').length % 4 === 1)
        throw new Error('invalid_base64url');
      const bytes = Buffer.from(data, 'base64url');
      if (typeof part.body?.size === 'number' && part.body.size !== bytes.length) {
        errors.push('mime_body_size_mismatch');
        return;
      }
      // Gmail has already removed Content-Transfer-Encoding. Rewrap decoded bytes as base64,
      // retaining Content-Type/charset so the mature MIME parser performs character decoding.
      const contentType = (header(part, 'content-type') ?? `${mime}; charset=utf-8`).replace(
        /[\r\n]/g,
        '',
      );
      const decoded = await simpleParser(
        Buffer.from(
          `Content-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}`,
        ),
        parserOptions,
      );
      if (mime === 'text/html' && typeof decoded.html === 'string') html.push(decoded.html);
      if (mime === 'text/plain' && typeof decoded.text === 'string') plain.push(decoded.text);
    } catch {
      errors.push('mime_body_decode_failed');
    }
  }
  await walk(payload);
  const htmlBody = html.length ? html.join('\n') : null;
  const plainBody = plain.length ? plain.join('\n') : null;
  const links: { url: string; anchorText: string; origin: 'html' | 'plain'; hints: string[] }[] =
    [];
  const addLink = (href: string, text: string, origin: 'html' | 'plain') => {
    const url = safeHttpUrl(href);
    if (!url) return;
    const lower = `${url} ${text}`.toLowerCase();
    const hints = [
      /unsubscribe|opt.out|退订/.test(lower) ? 'unsubscribe' : null,
      /view.in.browser|preferences|privacy|manage.subscription|网页|偏好/.test(lower)
        ? 'navigation'
        : null,
      /sponsor|advertis|广告|赞助/.test(lower) ? 'advertising' : null,
      /utm_|tracking|click\.|\/click[/?]|redirect/.test(lower) ? 'tracking' : null,
    ].filter((hint): hint is string => hint !== null);
    links.push({ url, anchorText: text, origin, hints });
  };
  if (htmlBody) {
    // JSDOM defaults: no scripts, resource loading or browser navigation.
    const dom = new JSDOM(htmlBody);
    try {
      for (const anchor of dom.window.document.querySelectorAll('a[href]'))
        addLink(anchor.getAttribute('href') ?? '', anchor.textContent?.trim() ?? '', 'html');
    } finally {
      dom.window.close();
    }
  }
  for (const match of plainBody?.matchAll(/https?:\/\/[^\s<>"']+/gi) ?? [])
    addLink(match[0], '', 'plain');
  const receivedMs = Number(message.internalDate);
  const hasBody = Boolean(htmlBody || plainBody);
  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId ?? null,
    from: envelope.from?.value ?? [],
    to: envelope.to
      ? (Array.isArray(envelope.to) ? envelope.to : [envelope.to]).flatMap((a) => a.value)
      : [],
    subject: envelope.subject ?? null,
    receivedAt:
      message.internalDate &&
      Number.isFinite(receivedMs) &&
      !Number.isNaN(new Date(receivedMs).getTime())
        ? new Date(receivedMs).toISOString()
        : null,
    dateHeader: header(payload, 'date'),
    messageIdHeader: header(payload, 'message-id'),
    labels: message.labelIds ?? [],
    html: htmlBody,
    plainText: plainBody,
    links,
    mimeType: payload.mimeType ?? 'unknown',
    mimeTypes,
    parseStatus: hasBody ? (errors.length || unavailableBodies ? 'partial' : 'success') : 'failed',
    errors: [
      ...errors,
      ...(unavailableBodies ? ['body_requires_attachment_fetch'] : []),
      ...(!hasBody ? ['no_available_body'] : []),
    ],
    bodyAvailability: { html: Boolean(htmlBody), plainText: Boolean(plainBody) },
    textParts,
    unavailableBodies,
    ignoredAttachments,
  };
}

export type ParsedMessage = Awaited<ReturnType<typeof parseMessage>>;
