import type { Pool } from "pg";
import type { PublishedAtScope } from "../lib/daily-scope.js";

type DuplicateRow = {
  id: string;
  title: string;
  url: string | null;
  contentText: string | null;
  sourceName: string;
  createdAt: Date;
};

export type PreStage1DuplicateSummary = {
  inputCount: number;
  duplicateCount: number;
  outputCount: number;
  duplicateRate: number;
  sameUrlCount: number;
  sameTitleCount: number;
  sameUrlAndTitleCount: number;
};

/** 在 Content Completion 前标记同一 Daily scope 中的 URL/title exact duplicates。 */
export async function ignorePreStage1ExactDuplicates(
  pool: Pool,
  scope: PublishedAtScope,
): Promise<PreStage1DuplicateSummary> {
  const result = await pool.query<DuplicateRow>(
    `select ra.id, ra.title, ra.url, ra.content_text as "contentText", s.name as "sourceName", ra.created_at as "createdAt"
       from raw_articles ra join sources s on s.id = ra.source_id
      where ra.stage1_status = 'pending'
        and ra.published_at >= $1::timestamptz and ra.published_at < $2::timestamptz
      order by ra.created_at asc, ra.id asc`,
    [scope.startAt, scope.endAt],
  );
  const rows = result.rows;
  const groups = new Map<string, DuplicateRow[]>();
  for (const row of rows) {
    for (const key of duplicateKeys(row)) {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  const losers = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = [...group].sort(compareDuplicateWinner)[0];
    for (const row of group) if (row.id !== winner.id) losers.add(row.id);
  }
  let sameUrlCount = 0;
  let sameTitleCount = 0;
  let sameUrlAndTitleCount = 0;
  for (const id of losers) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) continue;
    const url = row.url?.trim();
    const title = row.title.trim();
    const matchingRows = rows.filter((candidate) => candidate.id !== id);
    const sameUrl = Boolean(url && matchingRows.some((candidate) => candidate.url?.trim() === url));
    const sameTitle = Boolean(title && matchingRows.some((candidate) => candidate.title.trim() === title));
    const sameUrlAndTitle = Boolean(
      url && title && matchingRows.some(
        (candidate) => candidate.url?.trim() === url && candidate.title.trim() === title,
      ),
    );
    if (sameUrlAndTitle) sameUrlAndTitleCount += 1;
    else if (sameUrl) sameUrlCount += 1;
    else if (sameTitle) sameTitleCount += 1;
  }
  if (losers.size > 0) {
    await pool.query(
      `update raw_articles
          set stage1_status = 'ignored', stage1_processed_at = now(), processing_error = 'duplicate'
        where id = any($1::uuid[]) and stage1_status = 'pending'`,
      [[...losers]],
    );
  }
  return {
    inputCount: rows.length,
    duplicateCount: losers.size,
    outputCount: rows.length - losers.size,
    duplicateRate: rows.length === 0 ? 0 : losers.size / rows.length,
    sameUrlCount,
    sameTitleCount,
    sameUrlAndTitleCount,
  };
}

function duplicateKeys(row: DuplicateRow): string[] {
  const keys: string[] = [];
  const url = row.url?.trim();
  const title = row.title.trim();
  if (url) keys.push(`url:${url}`);
  if (title) keys.push(`title:${title}`);
  return keys;
}

function compareDuplicateWinner(left: DuplicateRow, right: DuplicateRow): number {
  const leftContent = left.contentText?.trim().length ?? 0;
  const rightContent = right.contentText?.trim().length ?? 0;
  return rightContent - leftContent
    || right.sourceName.length - left.sourceName.length
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}
