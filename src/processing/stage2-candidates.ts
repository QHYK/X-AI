import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage2CandidateRow = {
  processedContentId: string;
  title: string;
  summary: string | null;
  entities: string[] | null;
  source: string;
  url: string | null;
};

export type Stage2InputCandidate = {
  temp_id: string;
  title: string;
  summary: string;
  entities: string[];
  source: string;
  url: string | null;
};

export type Stage2Input = {
  event_candidates: Stage2InputCandidate[];
};

export type Stage2IdMap = Record<string, string>;

export type PreparedStage2Input = {
  input: Stage2Input;
  idMap: Stage2IdMap;
};

const DEFAULT_STAGE2_LOOKBACK_HOURS = 24;

export async function loadStage2EventCandidates(
  queryable: Queryable,
  options: {
    collectedWithinHours?: number;
  } = {},
): Promise<Stage2CandidateRow[]> {
  const collectedWithinHours = options.collectedWithinHours ?? DEFAULT_STAGE2_LOOKBACK_HOURS;
  const result = await queryable.query<Stage2CandidateRow>(
    `
      select
        pc.id as "processedContentId",
        ra.title,
        pc.summary,
        pc.entities,
        s.name as "source",
        ra.url
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = 'event'
        and ra.stage1_status = 'selected'
        and ra.collected_at >= now() - ($1::int * interval '1 hour')
      order by
        coalesce(ra.published_at, ra.collected_at) desc,
        s.name,
        pc.id
    `,
    [collectedWithinHours],
  );

  return result.rows;
}

export function prepareStage2Input(rows: Stage2CandidateRow[]): PreparedStage2Input {
  const input: Stage2Input = {
    event_candidates: rows.map((row, index) => ({
      temp_id: toTempId(index),
      title: row.title,
      summary: row.summary ?? "",
      entities: row.entities ?? [],
      source: row.source,
      url: row.url,
    })),
  };

  const idMap: Stage2IdMap = Object.fromEntries(
    rows.map((row, index) => [toTempId(index), row.processedContentId]),
  );

  validatePreparedStage2Input(input, idMap, rows);

  return { input, idMap };
}

export function validatePreparedStage2Input(
  input: Stage2Input,
  idMap: Stage2IdMap,
  rows: Stage2CandidateRow[],
) {
  const tempIds = input.event_candidates.map((candidate) => candidate.temp_id);
  const uniqueTempIds = new Set(tempIds);
  if (uniqueTempIds.size !== tempIds.length) {
    throw new Error("Stage 2 input contains duplicate temp_id values.");
  }

  for (const tempId of tempIds) {
    if (!idMap[tempId]) {
      throw new Error(`Missing id-map entry for ${tempId}.`);
    }
  }

  if (Object.keys(idMap).length !== input.event_candidates.length) {
    throw new Error("Stage 2 id map size does not match input candidate count.");
  }

  const processedContentIds = rows.map((row) => row.processedContentId);
  const uniqueProcessedContentIds = new Set(processedContentIds);
  if (uniqueProcessedContentIds.size !== processedContentIds.length) {
    throw new Error("Stage 2 query returned duplicate processed_content ids.");
  }
}

export function toTempId(index: number): string {
  return `E${String(index + 1).padStart(3, "0")}`;
}
