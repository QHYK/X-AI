/** Offline/explicit ingestion adapter. No Gmail, database connection, annotations or model calls here. */
import type { NormalizedRawArticle } from '../../src/collectors/raw-articles.js';
import { createPreview } from './review-preview.js';
import { createSourceGuidance } from './source-guided-selection.js';
import { newsletterSource, type NewsletterMail } from './newsletter-source.js';
import { safeHttpUrl } from './mail.js';

export function newsletterRawArticles(mail: NewsletterMail): NormalizedRawArticle[] {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mail.gmailMessageId) || !mail.html)
    throw new Error('A saved Gmail message ID and HTML are required');
  const receivedAt = new Date(mail.receivedAt ?? '');
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('Gmail receivedAt is required');
  const source = newsletterSource(mail);
  const guidance = createSourceGuidance(
    mail.html,
    source,
    createPreview(mail.html),
    mail.plainText ?? '',
    {
      subject: mail.subject ?? undefined,
      senderName: mail.from[0]?.name,
    },
  );
  if (!guidance.units.length)
    throw new Error(`No source-guided units: ${source}; ${guidance.warnings.join('; ')}`);
  return guidance.units.map((unit) => {
    if (!unit.title?.trim() || !unit.content_type || !unit.content_text.trim())
      throw new Error(`Incomplete source-guided unit: ${mail.gmailMessageId}/${unit.id}`);
    return {
      sourceItemOriginId: `gmail:${mail.gmailMessageId}:${unit.id}`,
      title: unit.title,
      url: unit.primary_url ? safeHttpUrl(unit.primary_url) : null,
      author: null,
      // Intake time of the newsletter, not an inferred publication time of linked articles.
      publishedAt: receivedAt,
      contentText: unit.content_text,
      imageUrl: null,
      sourceTags: null,
      metadata: {
        newsletter: {
          gmail_message_id: mail.gmailMessageId,
          unit_id: unit.id,
          content_type: unit.content_type,
          source_rule_version: guidance.version,
          template: guidance.template,
          source_range: unit.source_range,
          links: unit.urls,
        },
      },
    };
  });
}
