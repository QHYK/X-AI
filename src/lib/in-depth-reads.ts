import type { Pool } from 'pg';
import { z } from 'zod';

export const InDepthReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type InDepthReviewStatus = z.infer<typeof InDepthReviewStatusSchema>;

const EditorialOverridesSchema = z
  .object({
    title: z.string().max(300).optional(),
    author: z.string().max(300).optional(),
    summary: z.string().max(6_000).optional(),
    whyWorthReading: z.string().max(6_000).optional(),
  })
  .strict();

const ReviewUpdateSchema = z
  .object({
    id: z.uuid(),
    reviewStatus: InDepthReviewStatusSchema,
    editorialNotes: z.string().max(6_000).nullable(),
    editorialOverrides: EditorialOverridesSchema,
  })
  .strict();

export type InDepthReviewUpdate = z.infer<typeof ReviewUpdateSchema>;

export function parseInDepthReviewUpdate(value: unknown): InDepthReviewUpdate {
  return ReviewUpdateSchema.parse(value);
}

export type InDepthReviewItem = {
  id: string;
  candidateId: string;
  runId: string;
  reviewStatus: InDepthReviewStatus;
  editorialNotes: string | null;
  editorialOverrides: Record<string, unknown> | null;
  reviewedAt: string | null;
  createdAt: string;
  candidateCreatedAt: string;
  discoveryPath: 'direct' | 'topic' | 'open';
  url: string;
  originalTitle: string | null;
  titleZh: string | null;
  author: string | null;
  publication: string | null;
  contentType: string | null;
  estimatedDurationMinutes: number | null;
  summary: string | null;
  whyWorthReading: string | null;
  evidence: Record<string, unknown> | null;
  evaluation: Record<string, unknown> | null;
  extraInfo: Record<string, unknown>;
};

export type InDepthDisplayFields = {
  title: string;
  author: string | null;
  summary: string | null;
  whyWorthReading: string | null;
};

export type PublishedInDepthRead = Pick<
  InDepthReviewItem,
  | 'id'
  | 'url'
  | 'discoveryPath'
  | 'originalTitle'
  | 'titleZh'
  | 'author'
  | 'publication'
  | 'contentType'
  | 'estimatedDurationMinutes'
  | 'summary'
  | 'whyWorthReading'
  | 'editorialOverrides'
  | 'reviewedAt'
>;

type Queryable = Pick<Pool, 'query'>;

const REVIEW_COLUMNS = `
  idc.id, idc.discovery_candidate_id as "candidateId", dc.run_id as "runId",
  idc.review_status as "reviewStatus", idc.editorial_notes as "editorialNotes",
  idc.editorial_overrides as "editorialOverrides", idc.reviewed_at::text as "reviewedAt",
  idc.created_at::text as "createdAt", dc.created_at::text as "candidateCreatedAt",
  dc.discovery_path as "discoveryPath", dc.url,
  dc.title as "originalTitle", dc.title_zh as "titleZh", dc.author,
  dc.publication, dc.content_type as "contentType",
  dc.estimated_duration_minutes as "estimatedDurationMinutes",
  dc.summary, dc.why_worth_reading as "whyWorthReading",
  dc.evidence, dc.evaluation, dc.extra_info as "extraInfo"`;

export async function listInDepthReviewItems(
  db: Queryable,
  status: InDepthReviewStatus = 'pending',
): Promise<InDepthReviewItem[]> {
  const result = await db.query<InDepthReviewItem>(
    `select ${REVIEW_COLUMNS}
       from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where idc.review_status = $1
      order by dc.created_at desc, dc.id desc`,
    [status],
  );
  return result.rows;
}

export async function getInDepthReviewItem(
  db: Queryable,
  id: string,
): Promise<InDepthReviewItem | null> {
  const result = await db.query<InDepthReviewItem>(
    `select ${REVIEW_COLUMNS}
       from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where idc.id = $1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The only public In-depth Reads query: approval is the publication boundary. */
export async function listPublishedInDepthReads(db: Queryable): Promise<PublishedInDepthRead[]> {
  const result = await db.query<PublishedInDepthRead>(
    `select idc.id, idc.editorial_overrides as "editorialOverrides",
            idc.reviewed_at::text as "reviewedAt", dc.url,
            dc.discovery_path as "discoveryPath", dc.title as "originalTitle",
            dc.title_zh as "titleZh", dc.author, dc.publication,
            dc.content_type as "contentType",
            dc.estimated_duration_minutes as "estimatedDurationMinutes",
            dc.summary, dc.why_worth_reading as "whyWorthReading"
       from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where idc.review_status = 'approved'
      order by idc.reviewed_at desc nulls last, dc.created_at desc, dc.id desc`,
  );
  return result.rows;
}

export async function updateInDepthReviewItem(
  db: Queryable,
  value: InDepthReviewUpdate,
): Promise<InDepthReviewItem | null> {
  const input = parseInDepthReviewUpdate(value);
  const overrides = Object.fromEntries(
    Object.entries(input.editorialOverrides)
      .map(([key, text]) => [key, text?.trim()])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const result = await db.query<{ id: string }>(
    `update in_depth_candidates
        set review_status = $2,
            editorial_notes = $3,
            editorial_overrides = $4::jsonb,
            reviewed_at = case when $2 = 'pending' then null else now() end,
            updated_at = now()
      where id = $1::uuid
      returning id`,
    [
      input.id,
      input.reviewStatus,
      input.editorialNotes?.trim() || null,
      Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null,
    ],
  );
  return result.rows[0] ? getInDepthReviewItem(db, result.rows[0].id) : null;
}

/** Editorial values affect presentation only; original Candidate fields stay intact. */
export function displayInDepthFields(
  item: Pick<
    InDepthReviewItem,
    'editorialOverrides' | 'titleZh' | 'originalTitle' | 'author' | 'summary' | 'whyWorthReading'
  >,
): InDepthDisplayFields {
  const overrides = item.editorialOverrides;
  const edited = (key: keyof InDepthDisplayFields): string | null => {
    const value = overrides?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return {
    title: edited('title') ?? item.titleZh ?? item.originalTitle ?? 'Untitled work',
    author: edited('author') ?? item.author,
    summary: edited('summary') ?? item.summary,
    whyWorthReading: edited('whyWorthReading') ?? item.whyWorthReading,
  };
}
