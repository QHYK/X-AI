/** Shared Spike/Admin annotation interchange; not a production content source. */
import { z } from 'zod';
import type { NodeReference } from './html.js';
const nullableText = z.string().max(30_000).nullable();
const httpUrl = z
  .string()
  .max(30_000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'URL 必须为无凭据的 HTTP(S) 地址')
  .nullable();
export const statuses = ['unreviewed', 'accepted', 'rejected', 'uncertain'] as const;
export const contentTypes = ['external_reference', 'standalone_content', 'non_content'] as const;
export const unitSchema = z
  .object({
    manual_id: z.uuid().nullable(),
    status: z.enum(statuses),
    content_type: z.enum(contentTypes).nullable(),
    corrections: z
      .object({
        title: nullableText.optional(),
        summary: nullableText.optional(),
        original_url: httpUrl.optional(),
      })
      .strict(),
    boundary: z
      .object({
        start_node_id: z.string().regex(/^n\d+$/),
        end_node_id: z.string().regex(/^n\d+$/),
      })
      .strict()
      .nullable(),
    text_evidence: z.string().max(5000),
    notes: z.string().max(5000),
  })
  .strict();
export type EditableUnit = z.infer<typeof unitSchema>;
export type SavedUnit = EditableUnit & {
  boundary_references: { start: NodeReference; end: NodeReference } | null;
  source_guidance?: { version: number; review_label: string } | null;
};
export type SourceBaseline = {
  html_sha256: string;
  blocks_sha256: string;
};
export type Annotation = {
  schema_version: 1;
  gmail_message_id: string;
  source: SourceBaseline;
  added_units: SavedUnit[];
  updated_at: string;
  /** Optional human-only mail-level suggestion; never a Collector status update. */
  email_review?: { skip: boolean; notes: string };
};
