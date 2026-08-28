/**
 * Human Review 页面与 API 的服务端组合查询。
 *
 * Event snapshot、Candidates 和已有 Stage 4 Event 通过批量查询组合；Long-form 按同一 Daily scope 读取。
 */
import type { Pool } from "pg";
import { resolveDailyScope } from "./daily-scope.js";
import {
  EVENT_DISPLAY_CUTOFF,
  LONG_FORM_DISPLAY_CUTOFF,
} from "./ranking-config.js";

export type ReviewCandidate = {
  id: string;
  eventId: string | null;
  source: string;
  title: string;
  titleZh: string | null;
  summaryZh: string | null;
  tags: string[];
  entities: string[];
  entitiesZh: string[];
  url: string | null;
};

export type ReviewFinalEvent = {
  id: string;
  titleZh: string;
  summaryZh: string;
  tags: string[];
  tagsZh: string[];
  entities: string[];
  entitiesZh: string[];
};

export type EventReviewItem = {
  id: string;
  eventTempId: string;
  eventHint: string;
  aiRank: number;
  displayRank: number;
  candidates: ReviewCandidate[];
  finalEvent: ReviewFinalEvent | null;
};

export type EventReviewData = {
  dailyDate: string;
  reviewRunId: string | null;
  cutoff: number;
  items: EventReviewItem[];
};

export type LongFormReviewItem = {
  id: string;
  aiRank: number;
  displayRank: number;
  titleZh: string | null;
  source: string;
  summaryZh: string | null;
  url: string | null;
};

export type LongFormReviewData = {
  dailyDate: string;
  cutoff: number;
  items: LongFormReviewItem[];
};

type EventSnapshotRow = {
  id: string;
  review_run_id: string;
  event_temp_id: string;
  event_hint: string;
  ai_rank: number;
  display_rank: number;
  member_content_ids: string[];
};

type CandidateRow = {
  id: string;
  event_id: string | null;
  source: string;
  title: string;
  title_zh: string | null;
  summary_zh: string | null;
  tags: string[] | null;
  entities: string[] | null;
  entities_zh: string[] | null;
  url: string | null;
};

type FinalEventRow = {
  id: string;
  title_zh: string;
  summary_zh: string;
  tags: string[] | null;
  tags_zh: string[] | null;
  entities: string[] | null;
  entities_zh: string[] | null;
};

type EventMemberRow = {
  event_id: string;
  id: string;
};

/** 读取指定日期最新 Event Review snapshot，并批量补齐 Candidate 与已有 Stage 4 内容。 */
export async function getEventReviewData(
  pool: Pool,
  dailyDate: string,
): Promise<EventReviewData> {
  const latest = await pool.query<{ review_run_id: string }>(
    `
      select review_run_id
      from event_review_items
      where daily_date = $1::date
      group by review_run_id
      order by max(created_at) desc, review_run_id desc
      limit 1
    `,
    [dailyDate],
  );
  const reviewRunId = latest.rows[0]?.review_run_id ?? null;
  if (!reviewRunId) {
    return { dailyDate, reviewRunId: null, cutoff: EVENT_DISPLAY_CUTOFF, items: [] };
  }

  const snapshot = await pool.query<EventSnapshotRow>(
    `
      select
        id,
        review_run_id,
        event_temp_id,
        event_hint,
        ai_rank,
        display_rank,
        member_content_ids
      from event_review_items
      where review_run_id = $1::uuid
        and daily_date = $2::date
      order by display_rank, id
    `,
    [reviewRunId, dailyDate],
  );
  const memberIds = [...new Set(snapshot.rows.flatMap((row) => row.member_content_ids))];
  const candidateResult = memberIds.length
    ? await pool.query<CandidateRow>(
        `
          select
            pc.id,
            pc.event_id,
            s.name as source,
            ra.title,
            pc.title_zh,
            pc.summary_zh,
            pc.tags,
            pc.entities,
            pc.entities_zh,
            ra.url
          from processed_contents pc
          join raw_articles ra on ra.id = pc.raw_article_id
          join sources s on s.id = ra.source_id
          where pc.id = any($1::uuid[])
          order by ra.published_at asc nulls last, s.name, pc.id
        `,
        [memberIds],
      )
    : { rows: [] as CandidateRow[] };
  const candidateById = new Map(candidateResult.rows.map((row) => [row.id, row]));
  const eventIds = [
    ...new Set(candidateResult.rows.flatMap((row) => (row.event_id ? [row.event_id] : []))),
  ];
  const [finalEventResult, eventMemberResult] = eventIds.length
    ? await Promise.all([
        pool.query<FinalEventRow>(
          `
            select id, title_zh, summary_zh, tags, tags_zh, entities, entities_zh
            from events
            where id = any($1::uuid[])
          `,
          [eventIds],
        ),
        pool.query<EventMemberRow>(
          `
            select event_id, id
            from processed_contents
            where event_id = any($1::uuid[])
            order by event_id, id
          `,
          [eventIds],
        ),
      ])
    : [{ rows: [] as FinalEventRow[] }, { rows: [] as EventMemberRow[] }];
  const finalEventById = new Map(finalEventResult.rows.map((row) => [row.id, row]));
  const memberIdsByEventId = new Map<string, string[]>();
  for (const row of eventMemberResult.rows) {
    const ids = memberIdsByEventId.get(row.event_id) ?? [];
    ids.push(row.id);
    memberIdsByEventId.set(row.event_id, ids);
  }

  return {
    dailyDate,
    reviewRunId,
    cutoff: EVENT_DISPLAY_CUTOFF,
    items: snapshot.rows.map((row) => {
      const candidates = row.member_content_ids.flatMap((id): ReviewCandidate[] => {
        const candidate = candidateById.get(id);
        return candidate
          ? [{
              id: candidate.id,
              eventId: candidate.event_id,
              source: candidate.source,
              title: candidate.title,
              titleZh: candidate.title_zh,
              summaryZh: candidate.summary_zh,
              tags: candidate.tags ?? [],
              entities: candidate.entities ?? [],
              entitiesZh: candidate.entities_zh ?? [],
              url: candidate.url,
            }]
          : [];
      });
      const linkedEventIds = [...new Set(candidates.flatMap((item) => item.eventId ? [item.eventId] : []))];
      const linkedEventId = linkedEventIds.length === 1 ? linkedEventIds[0] : null;
      // Stage 3 重跑后的旧 event_id 只有在完整成员集合仍完全一致时才可视为对应 Stage 4 Event。
      const final =
        linkedEventId && sameIds(memberIdsByEventId.get(linkedEventId) ?? [], row.member_content_ids)
          ? finalEventById.get(linkedEventId)
          : undefined;
      return {
        id: row.id,
        eventTempId: row.event_temp_id,
        eventHint: row.event_hint,
        aiRank: row.ai_rank,
        displayRank: row.display_rank,
        candidates,
        finalEvent: final
          ? {
              id: final.id,
              titleZh: final.title_zh,
              summaryZh: final.summary_zh,
              tags: final.tags ?? [],
              tagsZh: final.tags_zh ?? [],
              entities: final.entities ?? [],
              entitiesZh: final.entities_zh ?? [],
            }
          : null,
      };
    }),
  };
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

/** 读取同一 Daily scope 内所有实际参与过 Stage 3 排名的 Long-form。 */
export async function getLongFormReviewData(
  pool: Pool,
  dailyDate: string,
): Promise<LongFormReviewData> {
  const scope = resolveDailyScope(dailyDate);
  const result = await pool.query<{
    id: string;
    ai_rank: number;
    display_rank: number;
    title_zh: string | null;
    source: string;
    summary_zh: string | null;
    url: string | null;
  }>(
    `
      select
        pc.id,
        pc.ai_rank,
        pc.display_rank,
        pc.title_zh,
        s.name as source,
        pc.summary_zh,
        ra.url
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = 'long_form'
        and pc.ai_rank is not null
        and pc.display_rank is not null
        and ra.published_at >= $1::timestamptz
        and ra.published_at < $2::timestamptz
      order by pc.display_rank, pc.id
    `,
    [scope.startAt, scope.endAt],
  );

  return {
    dailyDate,
    cutoff: LONG_FORM_DISPLAY_CUTOFF,
    items: result.rows.map((row) => ({
      id: row.id,
      aiRank: row.ai_rank,
      displayRank: row.display_rank,
      titleZh: row.title_zh,
      source: row.source,
      summaryZh: row.summary_zh,
      url: row.url,
    })),
  };
}
