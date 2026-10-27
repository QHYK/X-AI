import {
  EditorialIntroductionSchema,
  EditorialConflictError,
  readEditorialIntroduction,
  type EditorialIntroduction,
} from './in-depth-editorial.js';
import { discoveryEvidenceMetadata, resolveDiscoveryPublication } from './discovery-source.js';
import { loadDiscoverySources } from './discovery-source-list.js';
import {
  readDiscoveryContentMetadata,
  readDiscoveryContentEvidence,
  type DiscoveryCover,
  type DiscoveryTag,
} from './discovery-content-metadata.js';
import type { Pool } from 'pg';
import {
  IN_DEPTH_PAGE_SIZE,
  type InDepthCursor,
  encodeInDepthCursor,
} from './in-depth-pagination.js';
import { z } from 'zod';

export const InDepthReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type InDepthReviewStatus = z.infer<typeof InDepthReviewStatusSchema>;

const ReviewUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({ id: z.uuid(), action: z.literal('review'), reviewStatus: InDepthReviewStatusSchema })
    .strict(),
  z
    .object({
      id: z.uuid(),
      action: z.literal('notes'),
      editorialNotes: z.string().max(6_000).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      action: z.literal('editorial'),
      baseline: EditorialIntroductionSchema,
      ...EditorialIntroductionSchema.shape,
    })
    .strict(),
]);

export type InDepthReviewUpdate = z.infer<typeof ReviewUpdateSchema>;

export function parseInDepthReviewUpdate(value: unknown): InDepthReviewUpdate {
  return ReviewUpdateSchema.parse(value);
}

export type InDepthReviewItem = {
  id: string;
  candidateId: string;
  runId: string | null;
  reviewStatus: InDepthReviewStatus;
  editorialNotes: string | null;
  editorialOverrides: Record<string, unknown> | null;
  reviewedAt: string | null;
  createdAt: string;
  candidateCreatedAt: string;
  discoveryPath: 'direct' | 'topic' | 'open' | 'manual';
  url: string;
  originalTitle: string | null;
  titleZh: string | null;
  author: string | null;
  publishedAt?: string | null;
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
  | 'publishedAt'
  | 'publication'
  | 'contentType'
  | 'estimatedDurationMinutes'
  | 'summary'
  | 'whyWorthReading'
  | 'editorialOverrides'
  | 'reviewedAt'
> & { tags?: DiscoveryTag[]; cover?: DiscoveryCover | null; contentEvidence?: string[] };

type Queryable = Pick<Pool, 'query'>;

const DAILY_SOURCE_COLUMN = `(select s.name from processed_contents pc
     join raw_articles ra on ra.id = pc.raw_article_id
     join sources s on s.id = ra.source_id
    where pc.id = dc.source_content_id and dc.source_content_type = 'processed_content') as "dailySource"`;

// Preserve the existing admin response shape; persistence uses three independent TEXT columns.
const EDITORIAL_COLUMNS = `jsonb_build_object(
  'summary', idc.editorial_summary,
  'whyWorthReading', idc.editorial_why_worth_reading,
  'extra_info', idc.editorial_extra_info
) as "editorialOverrides"`;

const REVIEW_COLUMNS = `
  idc.id, idc.discovery_candidate_id as "candidateId", dc.run_id as "runId",
  idc.review_status as "reviewStatus", idc.editorial_notes as "editorialNotes",
  ${EDITORIAL_COLUMNS}, idc.reviewed_at::text as "reviewedAt",
  idc.created_at::text as "createdAt", dc.created_at::text as "candidateCreatedAt",
  dc.discovery_path as "discoveryPath", dc.url,
  dc.title as "originalTitle", dc.title_zh as "titleZh", dc.author, dc.published_at::text as "publishedAt",
  dc.publication, dc.content_type as "contentType",
  dc.estimated_duration_minutes as "estimatedDurationMinutes",
  dc.summary, dc.why_worth_reading as "whyWorthReading",
  dc.evidence, dc.evaluation, dc.extra_info as "extraInfo",
  ${DAILY_SOURCE_COLUMN}`;

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
  return normalizePublications(db, result.rows);
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
  return (await normalizePublications(db, result.rows))[0] ?? null;
}

/** The only public In-depth Reads query: approval is the publication boundary. */
export async function listPublishedInDepthReads(
  db: Queryable,
  cursor: InDepthCursor | null = null,
): Promise<PublishedInDepthRead[]> {
  const result = await db.query<
    PublishedInDepthRead & {
      evidence?: Record<string, unknown>;
      evaluation?: Record<string, unknown>;
      dailySource?: string;
    }
  >(
    `select idc.id, ${EDITORIAL_COLUMNS}, idc.id as "cursorId",
            to_char(idc.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt",
            idc.reviewed_at::text as "reviewedAt", dc.url,
            dc.discovery_path as "discoveryPath", dc.title as "originalTitle",
            dc.title_zh as "titleZh", dc.author, dc.publication,
            dc.published_at::text as "publishedAt",
            dc.content_type as "contentType",
            dc.estimated_duration_minutes as "estimatedDurationMinutes",
            dc.summary, dc.why_worth_reading as "whyWorthReading", dc.evidence, dc.evaluation,
            ${DAILY_SOURCE_COLUMN}
       from in_depth_candidates idc
       join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where idc.review_status = 'approved'
        and ($1::timestamptz is null or (idc.created_at, idc.id) < ($1::timestamptz, $2::uuid))
      order by idc.created_at desc, idc.id desc limit $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, IN_DEPTH_PAGE_SIZE + 1],
  );
  const normalized = await normalizePublications(db, result.rows);
  return normalized.map((row) => {
    const metadata = readDiscoveryContentMetadata({
      evidence: row.evidence ?? null,
      evaluation: row.evaluation ?? null,
    });
    const fields = { ...row };
    delete fields.evidence;
    delete fields.evaluation;
    return {
      ...fields,
      ...metadata,
      contentEvidence: readDiscoveryContentEvidence(row.evidence ?? null),
    };
  });
}

export async function getPublishedInDepthPage(db: Queryable, cursor: InDepthCursor | null = null) {
  const rows = await listPublishedInDepthReads(db, cursor);
  const hasMore = rows.length > IN_DEPTH_PAGE_SIZE;
  const items = rows.slice(0, IN_DEPTH_PAGE_SIZE);
  const last = items.at(-1) as
    (PublishedInDepthRead & { cursorId: string; cursorCreatedAt: string }) | undefined;
  return {
    items: items.map(toPublicInDepthRead),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeInDepthCursor({ id: last.cursorId, createdAt: last.cursorCreatedAt })
        : null,
  };
}

async function normalizePublications<
  T extends {
    url: string;
    publication: string | null;
    evidence?: Record<string, unknown> | null;
    dailySource?: string;
  },
>(db: Queryable, rows: T[]): Promise<T[]> {
  const sources = rows.length ? await loadDiscoverySources(db) : [];
  return rows.map((row) => {
    const fields = { ...row };
    delete fields.dailySource;
    return {
      ...fields,
      publication: resolveDiscoveryPublication({
        url: row.url,
        metadata: discoveryEvidenceMetadata(row.evidence),
        dailySource: row.dailySource,
        publication: row.publication,
        sources,
      }),
    } as T;
  });
}

export async function updateInDepthReviewItem(
  db: Queryable,
  value: InDepthReviewUpdate,
): Promise<InDepthReviewItem | null> {
  const input = parseInDepthReviewUpdate(value);
  if (input.action === 'editorial') {
    return (await saveInDepthEditorial(db, input.id, input, input.baseline))
      ? getInDepthReviewItem(db, input.id)
      : null;
  }
  const result =
    input.action === 'notes'
      ? await db.query<{ id: string }>(
          `update in_depth_candidates set editorial_notes = $2, updated_at = now()
        where id = $1::uuid returning id`,
          [input.id, input.editorialNotes?.trim() || null],
        )
      : await db.query<{ id: string }>(
          `update in_depth_candidates set review_status = $2,
          reviewed_at = case when $2 = 'pending' then null else now() end,
          updated_at = now() where id = $1::uuid returning id`,
          [input.id, input.reviewStatus],
        );
  return result.rows[0] ? getInDepthReviewItem(db, result.rows[0].id) : null;
}

/** Write only the three introduction columns; never touch approval, notes or Agent fields. */
export async function saveInDepthEditorial(
  db: Queryable,
  id: string,
  value: EditorialIntroduction,
  baseline: EditorialIntroduction,
): Promise<boolean> {
  const parsed = EditorialIntroductionSchema.parse({
    extra_info: value.extra_info,
    summary: value.summary,
    whyWorthReading: value.whyWorthReading,
  });
  const result = await db.query<{ id: string }>(
    `update in_depth_candidates
      set editorial_summary = $2,
          editorial_why_worth_reading = $3,
          editorial_extra_info = $4,
          updated_at = now()
      where id = $1::uuid
        and coalesce(editorial_summary, '') = $5
        and coalesce(editorial_why_worth_reading, '') = $6
        and coalesce(editorial_extra_info, '') = $7
      returning id`,
    [
      id,
      parsed.summary,
      parsed.whyWorthReading,
      parsed.extra_info,
      baseline.summary,
      baseline.whyWorthReading,
      baseline.extra_info,
    ],
  );
  if (result.rows[0]) return true;
  const current = await db.query<{
    summary: string | null;
    whyWorthReading: string | null;
    extra_info: string | null;
  }>(
    `select editorial_summary as summary, editorial_why_worth_reading as "whyWorthReading",
       editorial_extra_info as extra_info from in_depth_candidates where id = $1::uuid`,
    [id],
  );
  if (!current.rows[0]) return false;
  throw new EditorialConflictError(readEditorialIntroduction(current.rows[0]));
}

/** Editorial values affect presentation only; original Candidate fields stay intact. */
export function displayInDepthFields(
  item: Pick<
    InDepthReviewItem,
    'editorialOverrides' | 'titleZh' | 'originalTitle' | 'author' | 'summary' | 'whyWorthReading'
  >,
): InDepthDisplayFields {
  const overrides = item.editorialOverrides;
  const edited = (key: 'summary' | 'whyWorthReading'): string | null => {
    const value = overrides?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return {
    title: item.titleZh ?? item.originalTitle ?? 'Untitled work',
    author: item.author,
    summary: edited('summary') ?? item.summary,
    whyWorthReading: edited('whyWorthReading') ?? item.whyWorthReading,
  };
}

/** Explicit public allowlist; never serialize Review notes, evidence or arbitrary JSONB. */
export function toPublicInDepthRead(item: PublishedInDepthRead) {
  const display = displayInDepthFields(item);
  return {
    id: item.id,
    url: item.url,
    discoveryPath: item.discoveryPath,
    title: display.title,
    originalTitle: item.originalTitle,
    titleZh: item.titleZh,
    author: display.author,
    publication: item.publication,
    contentType: item.contentType,
    estimatedDurationMinutes: item.estimatedDurationMinutes,
    publishedAt: item.publishedAt ?? null,
    tags: item.tags ?? [],
    cover: item.cover ?? null,
    contentEvidence: item.contentEvidence ?? [],
    agent: {
      summary: item.summary,
      whyWorthReading: item.whyWorthReading,
    },
    editorial: readEditorialIntroduction(item.editorialOverrides),
    extra_info: readEditorialIntroduction(item.editorialOverrides).extra_info,
    summary: display.summary,
    whyWorthReading: display.whyWorthReading,
    reviewedAt: item.reviewedAt,
  };
}
