import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage3EventRankingItem = {
  id: string;
  event_hint: string;
  source_count: number;
  sources: Array<{
    source: string;
    title: string;
    summary: string;
  }>;
};

export type Stage3EventRankingInput = {
  events: Stage3EventRankingItem[];
};

export type Stage3ContentRankingItem = {
  id: string;
  title: string;
  summary: string;
  source: string;
};

export type Stage3DigestRankingInput = {
  category: string;
  candidates: Stage3ContentRankingItem[];
};

export type Stage3LongFormRankingInput = {
  candidates: Stage3ContentRankingItem[];
};

export type Stage3IdMaps = {
  events: Record<string, string[]>;
  digest: Record<string, Record<string, string>>;
  long_form: Record<string, string>;
};

export type Stage3PreparedValidationInput = {
  eventInput: Stage3EventRankingInput;
  digestInputs: Record<string, Stage3DigestRankingInput>;
  longFormInput: Stage3LongFormRankingInput;
  idMaps: Stage3IdMaps;
  sourceStage2Path: string;
};

export type Stage2MergeArtifact = {
  summary?: {
    success?: boolean;
  };
  input?: {
    event_candidates?: Array<{
      temp_id: string;
      title: string;
      summary: string;
      source: string;
    }>;
  };
  eventGroups?: Array<{
    event_hint: string;
    sources: Array<{
      temp_id: string;
      processed_content_id: string;
    }>;
  }>;
};

type Stage2RuntimeInputArtifact = {
  event_candidates?: Array<{
    temp_id: string;
    title: string;
    summary: string;
    source: string;
  }>;
};

type Stage2RuntimeOutputArtifact = {
  events?: Array<{
    event_hint: string;
    sources: string[];
  }>;
};

type ProcessedContentRankingRow = {
  processedContentId: string;
  category: string;
  title: string;
  summary: string | null;
  source: string;
};

const DEFAULT_STAGE3_LOOKBACK_HOURS = 24;
const DEFAULT_STAGE2_MERGE_RESULT_PATH = "docs/spikes/stage2-merge-result.json";

export async function prepareStage3ValidationInput(
  queryable: Queryable,
  options: {
    collectedWithinHours?: number;
    stage2MergeResultPath?: string;
  } = {},
): Promise<Stage3PreparedValidationInput> {
  const stage2Path = options.stage2MergeResultPath ?? DEFAULT_STAGE2_MERGE_RESULT_PATH;
  const stage2 = await readStage2MergeArtifact(stage2Path);
  const eventInput = buildEventRankingInput(stage2);
  const digestRows = await loadRankingRows(queryable, "digest", options.collectedWithinHours);
  const longFormRows = await loadRankingRows(queryable, "long_form", options.collectedWithinHours);
  const digestInputs = buildDigestInputs(digestRows);
  const longFormInput = buildLongFormInput(longFormRows);

  return {
    eventInput,
    digestInputs,
    longFormInput,
    idMaps: {
      events: buildEventIdMap(eventInput, stage2),
      digest: buildDigestIdMaps(digestRows, digestInputs),
      long_form: buildLongFormIdMap(longFormRows, longFormInput),
    },
    sourceStage2Path: stage2Path,
  };
}

async function readStage2MergeArtifact(path: string): Promise<Stage2MergeArtifact> {
  const pathStat = await stat(path);
  if (pathStat.isDirectory()) {
    return readStage2RuntimeDirectory(path);
  }

  const artifact = JSON.parse(await readFile(path, "utf8")) as Stage2MergeArtifact;
  if (artifact.summary && artifact.summary.success !== true) {
    throw new Error(`Stage 2 merge artifact is not successful: ${path}`);
  }

  if (!Array.isArray(artifact.eventGroups) || !Array.isArray(artifact.input?.event_candidates)) {
    throw new Error(`Stage 2 merge artifact is missing eventGroups or input candidates: ${path}`);
  }

  return artifact;
}

async function readStage2RuntimeDirectory(path: string): Promise<Stage2MergeArtifact> {
  const run = JSON.parse(await readFile(join(path, "run.json"), "utf8")) as {
    status?: string;
  };
  if (run.status !== "success") {
    throw new Error(`Stage 2 runtime directory is not successful: ${path}`);
  }

  const input = JSON.parse(
    await readFile(join(path, "input.json"), "utf8"),
  ) as Stage2RuntimeInputArtifact;
  const idMap = JSON.parse(await readFile(join(path, "id-map.json"), "utf8")) as Record<
    string,
    string
  >;
  const output = JSON.parse(
    await readFile(join(path, "output.json"), "utf8"),
  ) as Stage2RuntimeOutputArtifact;

  return {
    summary: {
      success: true,
    },
    input: {
      event_candidates: input.event_candidates ?? [],
    },
    eventGroups:
      output.events?.map((event) => ({
        event_hint: event.event_hint,
        sources: event.sources.map((tempId) => {
          const processedContentId = idMap[tempId];
          if (!processedContentId) {
            throw new Error(`Stage 2 runtime output references unmapped temp_id ${tempId}.`);
          }

          return {
            temp_id: tempId,
            processed_content_id: processedContentId,
          };
        }),
      })) ?? [],
  };
}

function buildEventRankingInput(stage2: Stage2MergeArtifact): Stage3EventRankingInput {
  const candidateByTempId = new Map(
    stage2.input?.event_candidates?.map((candidate) => [candidate.temp_id, candidate]) ?? [],
  );

  return {
    events:
      stage2.eventGroups?.map((group, index) => ({
        id: toEventId(index),
        event_hint: group.event_hint,
        source_count: group.sources.length,
        sources: group.sources.map((source) => {
          const candidate = candidateByTempId.get(source.temp_id);
          if (!candidate) {
            throw new Error(`Stage 2 event group references unknown temp_id ${source.temp_id}.`);
          }

          return {
            source: candidate.source,
            title: candidate.title,
            summary: candidate.summary,
          };
        }),
      })) ?? [],
  };
}

async function loadRankingRows(
  queryable: Queryable,
  routing: "digest" | "long_form",
  collectedWithinHours = DEFAULT_STAGE3_LOOKBACK_HOURS,
): Promise<ProcessedContentRankingRow[]> {
  const result = await queryable.query<ProcessedContentRankingRow>(
    `
      select
        pc.id as "processedContentId",
        pc.category,
        ra.title,
        pc.summary,
        s.name as "source"
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = $1
        and ra.stage1_status = 'selected'
        and ra.collected_at >= now() - ($2::int * interval '1 hour')
      order by
        pc.category,
        coalesce(ra.published_at, ra.collected_at) desc,
        s.name,
        pc.id
    `,
    [routing, collectedWithinHours],
  );

  return result.rows;
}

function buildDigestInputs(
  rows: ProcessedContentRankingRow[],
): Record<string, Stage3DigestRankingInput> {
  const rowsByCategory = new Map<string, ProcessedContentRankingRow[]>();
  for (const row of rows) {
    const categoryRows = rowsByCategory.get(row.category) ?? [];
    categoryRows.push(row);
    rowsByCategory.set(row.category, categoryRows);
  }

  return Object.fromEntries(
    [...rowsByCategory.entries()].map(([category, categoryRows]) => [
      category,
      {
        category,
        candidates: categoryRows.map((row, index) => ({
          id: toDigestId(index),
          title: row.title,
          summary: row.summary ?? "",
          source: row.source,
        })),
      },
    ]),
  );
}

function buildLongFormInput(rows: ProcessedContentRankingRow[]): Stage3LongFormRankingInput {
  return {
    candidates: rows.map((row, index) => ({
      id: toLongFormId(index),
      title: row.title,
      summary: row.summary ?? "",
      source: row.source,
    })),
  };
}

function buildEventIdMap(
  input: Stage3EventRankingInput,
  stage2: Stage2MergeArtifact,
): Record<string, string[]> {
  const groups = stage2.eventGroups ?? [];
  return Object.fromEntries(
    input.events.map((event, index) => [
      event.id,
      groups[index].sources.map((source) => source.processed_content_id),
    ]),
  );
}

function buildDigestIdMaps(
  rows: ProcessedContentRankingRow[],
  inputs: Record<string, Stage3DigestRankingInput>,
): Record<string, Record<string, string>> {
  const rowsByCategory = new Map<string, ProcessedContentRankingRow[]>();
  for (const row of rows) {
    const categoryRows = rowsByCategory.get(row.category) ?? [];
    categoryRows.push(row);
    rowsByCategory.set(row.category, categoryRows);
  }

  return Object.fromEntries(
    Object.entries(inputs).map(([category, input]) => {
      const categoryRows = rowsByCategory.get(category) ?? [];
      return [
        category,
        Object.fromEntries(
          input.candidates.map((candidate, index) => [
            candidate.id,
            categoryRows[index].processedContentId,
          ]),
        ),
      ];
    }),
  );
}

function buildLongFormIdMap(
  rows: ProcessedContentRankingRow[],
  input: Stage3LongFormRankingInput,
): Record<string, string> {
  return Object.fromEntries(
    input.candidates.map((candidate, index) => [candidate.id, rows[index].processedContentId]),
  );
}

function toEventId(index: number): string {
  return `EV${String(index + 1).padStart(3, "0")}`;
}

function toDigestId(index: number): string {
  return `D${String(index + 1).padStart(3, "0")}`;
}

function toLongFormId(index: number): string {
  return `L${String(index + 1).padStart(3, "0")}`;
}
