import { z } from 'zod';
import type { NodeReference } from '../collectors/gmail/html.js';
import type { GuidedUnit } from '../collectors/gmail/source-guided-selection.js';
import { unitSchema, type Annotation } from '../collectors/gmail/annotation.js';
export const REVIEW_STATUS_LABELS = {
  unreviewed: '未审核',
  accepted: '确认',
  rejected: '拒绝',
  uncertain: '不确定',
} as const;
export const NewsletterReviewUnitSchema = unitSchema
  .omit({ manual_id: true })
  .extend({ id: z.uuid() });
export type NewsletterReviewUnit = z.infer<typeof NewsletterReviewUnitSchema>;

/** Exact Spike schema v1 interchange; never writes Raw or parser rules. */
export function defaultNewsletterReview(units: GuidedUnit[]): NewsletterReviewUnit[] {
  return units.map((u) => ({
    id: u.id,
    status: 'unreviewed',
    content_type: u.content_type,
    corrections: { title: u.title, summary: null, original_url: u.primary_url },
    boundary: u.boundary,
    text_evidence: '',
    notes: '',
  }));
}
export function exportNewsletterAnnotation(
  detail: {
    id: string;
    html_sha256: string;
    blocks_sha256: string;
    blocks: NodeReference[];
    units: GuidedUnit[];
    currentParserVersion: number;
  },
  units: NewsletterReviewUnit[],
  emailReview?: { skip: boolean; notes: string },
): Annotation {
  const ids = new Set<string>();
  return {
    ...(emailReview && (emailReview.skip || emailReview.notes)
      ? { email_review: emailReviewSchema.parse(emailReview) }
      : {}),
    schema_version: 1,
    gmail_message_id: detail.id,
    source: { html_sha256: detail.html_sha256, blocks_sha256: detail.blocks_sha256 },
    updated_at: new Date().toISOString(),
    added_units: units.map((input) => {
      const u = NewsletterReviewUnitSchema.parse(input);
      if (ids.has(u.id)) throw new Error('内容 ID 重复');
      ids.add(u.id);
      let boundary_references: Annotation['added_units'][number]['boundary_references'] = null;
      if (u.boundary) {
        const a = detail.blocks.findIndex((b) => b.node_id === u.boundary!.start_node_id),
          b = detail.blocks.findIndex((b) => b.node_id === u.boundary!.end_node_id);
        if (a < 0 || b < a) throw new Error('内容边界不存在或顺序不正确');
        boundary_references = { start: detail.blocks[a], end: detail.blocks[b] };
      }
      if (
        u.status === 'accepted' &&
        (!u.content_type ||
          !u.corrections.title?.trim() ||
          (!u.boundary && !u.text_evidence.trim()))
      )
        throw new Error('确认内容需要标题、类型和原文边界或证据');
      const { id, ...rest } = u,
        original = detail.units.find((p) => p.id === id);
      return {
        ...rest,
        manual_id: id,
        boundary_references,
        source_guidance: original
          ? { version: detail.currentParserVersion, review_label: original.review_label }
          : null,
      };
    }),
  };
}
export function importNewsletterAnnotation(
  detail: { id: string; html_sha256: string; blocks_sha256: string },
  value: unknown,
): NewsletterReviewUnit[] {
  const data = value as Annotation;
  if (
    data?.schema_version !== 1 ||
    data.gmail_message_id !== detail.id ||
    data.source?.html_sha256 !== detail.html_sha256 ||
    data.source?.blocks_sha256 !== detail.blocks_sha256 ||
    !Array.isArray(data.added_units) ||
    data.added_units.length > 2000
  )
    throw new Error('标注文件与当前邮件或边界不匹配');
  const ids = new Set<string>();
  return data.added_units.map((u) => {
    const unit = NewsletterReviewUnitSchema.parse({
      id: u.manual_id,
      status: u.status,
      content_type: u.content_type,
      corrections: {
        title: u.corrections.title ?? null,
        summary: u.corrections.summary ?? null,
        original_url: u.corrections.original_url ?? null,
      },
      boundary: u.boundary,
      text_evidence: u.text_evidence,
      notes: u.notes,
    });
    if (ids.has(unit.id)) throw new Error('内容 ID 重复');
    ids.add(unit.id);
    return unit;
  });
}

const emailReviewSchema = z.object({ skip: z.boolean(), notes: z.string().max(5000) }).strict();
export function readNewsletterEmailReview(value: unknown) {
  const review = (value as { email_review?: unknown })?.email_review;
  return review === undefined ? { skip: false, notes: '' } : emailReviewSchema.parse(review);
}
