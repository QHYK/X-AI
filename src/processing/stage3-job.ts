import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type {
  Stage3DigestRankingCandidate,
  Stage3DigestRankingInput,
} from "../prompts/stage3-digest-ranking.js";
import type { Stage3LongFormRankingInput } from "../prompts/stage3-long-form-ranking.js";
import {
  runStage3DigestRankingLlm,
  type Stage3DigestRankingResult,
} from "./stage3-digest-ranking-llm.js";
import {
  runStage3EventRankingLlm,
  type Stage3EventRankingResult,
} from "./stage3-event-ranking-llm.js";
import {
  runStage3LongFormRankingLlm,
  type Stage3LongFormRankingResult,
} from "./stage3-long-form-ranking-llm.js";
import {
  persistStage3Ranks,
  type RankingPersistenceUpdate,
  type Stage3PersistenceResult,
} from "./stage3-persistence.js";
import {
  validateStage2Assignments,
  validateStage2Output,
  type Stage2Input,
  type Stage2Output,
} from "./stage2-contract.js";
import type { Stage3RankingOutput } from "./stage3-contract.js";
import type { Stage3EventRankingInput } from "./stage3-validation-input.js";
import { inferSciencePublication } from "./science-publication.js";
import { normalizeArticleUrl } from "./url-normalization.js";

type Queryable = Pick<Pool | PoolClient, "query">;

type Stage2RunArtifact = {
  status?: string;
  model?: string;
  candidate_count?: number;
  event_group_count?: number;
};

type Stage2IdMap = Record<string, string>;

type RankingCandidateRow = {
  processedContentId: string;
  category: string;
  title: string;
  summary: string | null;
  source: string;
  sourcePriority: string;
  url: string | null;
};

type RankingRecord<TCandidate> = {
  category: string;
  candidate: TCandidate;
  processedContentId: string;
  sourcePriority: string;
  url: string | null;
  normalizedUrl: string | null;
  originalIndex: number;
};

type ContentCandidate = {
  id: string;
  title: string;
  summary: string;
  source: string;
};

type DigestRecord = RankingRecord<Stage3DigestRankingCandidate>;
type LongFormRecord = RankingRecord<ContentCandidate>;

type RemovedByCrossChannel = {
  channel: "digest" | "long_form";
  category: string | null;
  id: string;
  title: string;
  processed_content_id: string;
  matched_event_id: string;
  normalized_url: string;
  duplicate_reason: string;
};

type DigestDuplicateGroup = {
  normalized_url: string;
  kept: DuplicateItem;
  removed: Array<DuplicateItem & { reason: string }>;
  winner_reason: string;
};

type DuplicateItem = {
  id: string;
  title: string;
  category: string;
  source: string;
};

type Stage3IdMap = {
  events: Record<string, string[]>;
  digest: Record<string, Record<string, string>>;
  long_form: Record<string, string>;
};

export type Stage3JobOptions = {
  stage2RunDir?: string;
  collectedWithinHours?: number;
  eventTopN?: number;
  model?: string;
  rootDir?: string;
};

export type Stage3JobResult = {
  success: boolean;
  runDir: string;
  error: string | null;
  eventGroupCount: number;
  eventSelectedCount: number;
  crossChannelRemovedCount: number;
  digestBeforeDedup: number;
  digestAfterDedup: number;
  digestCategoryCounts: Record<string, number>;
  longFormCount: number;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  persistence: Stage3PersistenceResult | null;
};

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_EVENT_TOP_N = 10;
const DEFAULT_MODEL = "gpt-5.4-mini";
const CATEGORY_ORDER = [
  "Company",
  "Finance & Economy",
  "General",
  "Policy",
  "Science",
  "Technology",
];
const CROSS_CHANNEL_DUPLICATE_REASON =
  "normalized_url matches a selected Top N Event article URL";

export async function processStage3(
  pool: Pool,
  options: Stage3JobOptions = {},
): Promise<Stage3JobResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const startedAt = new Date();
  const runId = toRunTimestamp(startedAt);
  const runDir = join(rootDir, "runtime/stage3", runId);
  const eventsDir = join(runDir, "events");
  const dedupDir = join(runDir, "dedup");
  const digestDir = join(runDir, "digest");
  const longFormDir = join(runDir, "long-form");
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const eventTopN = options.eventTopN ?? DEFAULT_EVENT_TOP_N;
  const collectedWithinHours = options.collectedWithinHours ?? DEFAULT_LOOKBACK_HOURS;

  await mkdir(eventsDir, { recursive: true });
  await mkdir(dedupDir, { recursive: true });
  await mkdir(digestDir, { recursive: true });
  await mkdir(longFormDir, { recursive: true });

  let sourceStage2RunDir = "";
  let eventGroupCount = 0;
  let eventSelectedCount = 0;
  let crossChannelRemovedCount = 0;
  let digestBeforeDedup = 0;
  let digestAfterDedup = 0;
  let digestCategoryCounts: Record<string, number> = {};
  let longFormCount = 0;
  let llmCallCount = 0;
  let retryCount = 0;
  let llmDurationMs = 0;
  let persistence: Stage3PersistenceResult | null = null;
  let persistenceStatus: "not_started" | "success" | "failed" = "not_started";
  let error: string | null = null;

  try {
    const stage2 = await loadSuccessfulStage2Run(rootDir, options.stage2RunDir);
    sourceStage2RunDir = stage2.runDir;
    const eventBundle = buildEventRankingInput(stage2.input, stage2.output, stage2.idMap);
    eventGroupCount = eventBundle.input.events.length;
    await writeJson(join(eventsDir, "input.json"), eventBundle.input);

    const digestRows = await loadRankingRows(pool, "digest", collectedWithinHours);
    const longFormRows = await loadRankingRows(pool, "long_form", collectedWithinHours);
    const digestRecords = buildDigestRecords(digestRows);
    const longFormRecords = buildLongFormRecords(longFormRows);
    digestBeforeDedup = digestRecords.length;

    const eventRanking = await rankEvents(eventBundle.input, { model });
    llmCallCount += eventRanking.calls;
    retryCount += eventRanking.retries;
    llmDurationMs += eventRanking.durationMs;
    await writeJson(join(eventsDir, "ranking-output.json"), eventRanking.output);

    const selectedEvents = selectTopEvents({
      rankingOutput: eventRanking.output,
      eventInput: eventBundle.input,
      eventIdMap: eventBundle.idMap,
      topN: eventTopN,
    });
    eventSelectedCount = selectedEvents.events.length;
    await writeJson(join(eventsDir, "selected.json"), selectedEvents);

    const selectedArticleKeys = await buildSelectedEventArticleKeys(pool, selectedEvents.idMap);
    const crossDeduped = applyCrossChannelDedup({
      digestRecords,
      longFormRecords,
      selectedKeyToEventId: selectedArticleKeys.keyToEventId,
    });
    crossChannelRemovedCount = crossDeduped.removed.length;
    await writeJson(join(dedupDir, "cross-channel.json"), {
      selected_event_article_keys: selectedArticleKeys.artifact,
      removed_items: crossDeduped.removed,
      digest_before: digestRecords.length,
      digest_after: crossDeduped.digestRecords.length,
      long_form_before: longFormRecords.length,
      long_form_after: crossDeduped.longFormRecords.length,
    });

    const digestDeduped = dedupDigestRecords(crossDeduped.digestRecords);
    digestAfterDedup = digestDeduped.keptRecords.length;
    digestCategoryCounts = countByCategory(digestDeduped.keptRecords);
    longFormCount = crossDeduped.longFormRecords.length;
    await writeJson(join(dedupDir, "digest.json"), {
      duplicate_groups: digestDeduped.duplicateGroups,
      digest_before: crossDeduped.digestRecords.length,
      duplicate_items_removed: digestDeduped.removedRecords.length,
      digest_after: digestDeduped.keptRecords.length,
      categories: buildCategorySummary(
        crossDeduped.digestRecords,
        digestDeduped.removedRecords,
        digestDeduped.keptRecords,
      ),
    });

    const digestInputs = buildDigestInputs(digestDeduped.keptRecords);
    const longFormInput = buildLongFormInput(crossDeduped.longFormRecords);
    const idMap: Stage3IdMap = {
      events: selectedEvents.idMap,
      digest: buildDigestIdMap(digestDeduped.keptRecords),
      long_form: buildLongFormIdMap(crossDeduped.longFormRecords),
    };

    await writeJson(join(runDir, "id-map.json"), idMap);
    for (const input of Object.values(digestInputs)) {
      if (input.candidates.length === 0) {
        continue;
      }

      await writeJson(join(digestDir, `${toSlug(input.category)}-input.json`), input);
    }
    await writeJson(join(longFormDir, "input.json"), longFormInput);

    const digestRankings: Record<string, Stage3RankingOutput> = {};
    for (const category of Object.keys(digestInputs).sort(compareCategoryNames)) {
      const input = digestInputs[category];
      if (!input || input.candidates.length === 0) {
        continue;
      }

      const result = await rankDigest(input, { model });
      llmCallCount += result.calls;
      retryCount += result.retries;
      llmDurationMs += result.durationMs;
      digestRankings[category] = result.output;
      await writeJson(join(digestDir, `${toSlug(category)}-ranking-output.json`), result.output);
    }

    const longFormRanking = await rankLongForm(longFormInput, { model });
    llmCallCount += longFormRanking.calls;
    retryCount += longFormRanking.retries;
    llmDurationMs += longFormRanking.durationMs;
    await writeJson(join(longFormDir, "ranking-output.json"), longFormRanking.output);

    const persistencePlan = buildPersistencePlan({
      allDigestRecords: digestRecords,
      allLongFormRecords: longFormRecords,
      finalDigestIdMap: idMap.digest,
      finalLongFormIdMap: idMap.long_form,
      digestRankings,
      longFormRanking: longFormRanking.output,
    });
    await writeJson(join(runDir, "persistence-plan.json"), persistencePlan);

    persistenceStatus = "failed";
    const client = await pool.connect();
    try {
      await client.query("begin");
      persistence = await persistStage3Ranks(client, persistencePlan);
      await client.query("commit");
      persistenceStatus = "success";
    } catch (transactionError) {
      await client.query("rollback");
      throw transactionError;
    } finally {
      client.release();
    }

    await writeRunJson(join(runDir, "run.json"), {
      runId,
      sourceStage2RunDir,
      startedAt,
      finishedAt: new Date(),
      model,
      status: "success",
      collectedWithinHours,
      eventGroupCount,
      eventSelectedCount,
      crossChannelRemovedCount,
      digestBeforeDedup,
      digestAfterDedup,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      persistenceStatus,
      persistence,
      error: null,
    });

    return {
      success: true,
      runDir,
      error: null,
      eventGroupCount,
      eventSelectedCount,
      crossChannelRemovedCount,
      digestBeforeDedup,
      digestAfterDedup,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      persistence,
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await writeRunJson(join(runDir, "run.json"), {
      runId,
      sourceStage2RunDir,
      startedAt,
      finishedAt: new Date(),
      model,
      status: "failed",
      collectedWithinHours,
      eventGroupCount,
      eventSelectedCount,
      crossChannelRemovedCount,
      digestBeforeDedup,
      digestAfterDedup,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      persistenceStatus,
      persistence,
      error,
    });

    return {
      success: false,
      runDir,
      error,
      eventGroupCount,
      eventSelectedCount,
      crossChannelRemovedCount,
      digestBeforeDedup,
      digestAfterDedup,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      persistence,
    };
  }
}

async function loadSuccessfulStage2Run(
  rootDir: string,
  stage2RunDirOption?: string,
): Promise<{
  runDir: string;
  run: Stage2RunArtifact;
  input: Stage2Input;
  output: Stage2Output;
  idMap: Stage2IdMap;
}> {
  const runDir = stage2RunDirOption
    ? normalizeRuntimePath(rootDir, stage2RunDirOption)
    : await findLatestSuccessfulStage2RunDir(rootDir);
  const run = await readJson<Stage2RunArtifact>(join(runDir, "run.json"));
  if (run.status !== "success") {
    throw new Error(`Stage 2 runtime directory is not successful: ${runDir}`);
  }

  const input = await readJson<Stage2Input>(join(runDir, "input.json"));
  const rawOutput = await readJson<unknown>(join(runDir, "output.json"));
  const idMap = await readJson<Stage2IdMap>(join(runDir, "id-map.json"));
  const outputValidation = validateStage2Output(rawOutput);
  if (!outputValidation.success) {
    throw new Error(`Stage 2 output validation failed: ${outputValidation.errors.join("; ")}`);
  }

  const assignment = validateStage2Assignments(outputValidation.output, input);
  if (!assignment.passed) {
    throw new Error(`Stage 2 assignment validation failed: ${assignment.errors.join("; ")}`);
  }

  await stat(join(runDir, "output.json"));
  return {
    runDir,
    run,
    input,
    output: outputValidation.output,
    idMap,
  };
}

async function findLatestSuccessfulStage2RunDir(rootDir: string): Promise<string> {
  const root = join(rootDir, "runtime/stage2");
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    try {
      const run = await readJson<Stage2RunArtifact>(join(candidate, "run.json"));
      await stat(join(candidate, "input.json"));
      await stat(join(candidate, "id-map.json"));
      await stat(join(candidate, "output.json"));
      if (run.status === "success") {
        return candidate;
      }
    } catch (caught) {
      if (!isMissingPathError(caught)) {
        throw caught;
      }
    }
  }

  throw new Error(`No successful Stage 2 runtime run found under ${root}.`);
}

function buildEventRankingInput(
  stage2Input: Stage2Input,
  stage2Output: Stage2Output,
  stage2IdMap: Stage2IdMap,
): {
  input: Stage3EventRankingInput;
  idMap: Record<string, string[]>;
} {
  const candidateByTempId = new Map(
    stage2Input.event_candidates.map((candidate) => [candidate.temp_id, candidate]),
  );
  const eventIdMap: Record<string, string[]> = {};

  const events = stage2Output.events.map((event, index) => {
    const eventId = toEventId(index);
    eventIdMap[eventId] = event.sources.map((tempId) => {
      const processedContentId = stage2IdMap[tempId];
      if (!processedContentId) {
        throw new Error(`Stage 2 id-map is missing processed_content_id for ${tempId}.`);
      }

      return processedContentId;
    });

    return {
      id: eventId,
      event_hint: event.event_hint,
      source_count: event.sources.length,
      sources: event.sources.map((tempId) => {
        const candidate = candidateByTempId.get(tempId);
        if (!candidate) {
          throw new Error(`Stage 2 output references unknown temp_id ${tempId}.`);
        }

        return {
          source: candidate.source,
          title: candidate.title,
          summary: candidate.summary,
        };
      }),
    };
  });

  return {
    input: { events },
    idMap: eventIdMap,
  };
}

async function loadRankingRows(
  queryable: Queryable,
  routing: "digest" | "long_form",
  collectedWithinHours: number,
): Promise<RankingCandidateRow[]> {
  const result = await queryable.query<RankingCandidateRow>(
    `
      select
        pc.id as "processedContentId",
        pc.category,
        ra.title,
        pc.summary,
        s.name as "source",
        s.priority as "sourcePriority",
        ra.url
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

function buildDigestRecords(rows: RankingCandidateRow[]): DigestRecord[] {
  const indexByCategory = new Map<string, number>();
  return rows.map((row, originalIndex) => {
    const categoryIndex = indexByCategory.get(row.category) ?? 0;
    indexByCategory.set(row.category, categoryIndex + 1);

    return {
      category: row.category,
      candidate: {
        id: toDigestId(categoryIndex),
        title: row.title,
        summary: row.summary ?? "",
        source: row.source,
        publication:
          row.category === "Science"
            ? inferSciencePublication({ url: row.url, sourceName: row.source }).publication
            : undefined,
      },
      processedContentId: row.processedContentId,
      sourcePriority: row.sourcePriority,
      url: row.url,
      normalizedUrl: normalizeArticleUrl(row.url),
      originalIndex,
    };
  });
}

function buildLongFormRecords(rows: RankingCandidateRow[]): LongFormRecord[] {
  return rows.map((row, index) => ({
    category: row.category,
    candidate: {
      id: toLongFormId(index),
      title: row.title,
      summary: row.summary ?? "",
      source: row.source,
    },
    processedContentId: row.processedContentId,
    sourcePriority: row.sourcePriority,
    url: row.url,
    normalizedUrl: normalizeArticleUrl(row.url),
    originalIndex: index,
  }));
}

async function rankEvents(
  input: Stage3EventRankingInput,
  options: { model: string },
): Promise<{ output: Stage3RankingOutput; calls: number; retries: number; durationMs: number }> {
  if (input.events.length === 0) {
    return { output: { rankings: [] }, calls: 0, retries: 0, durationMs: 0 };
  }

  const result = await runStage3EventRankingLlm(input, options);
  assertRankingSuccess("Event Ranking", result);
  return rankingMetrics(result);
}

async function rankDigest(
  input: Stage3DigestRankingInput,
  options: { model: string },
): Promise<{ output: Stage3RankingOutput; calls: number; retries: number; durationMs: number }> {
  const result = await runStage3DigestRankingLlm(input, options);
  assertRankingSuccess(`Digest Ranking (${input.category})`, result);
  return rankingMetrics(result);
}

async function rankLongForm(
  input: Stage3LongFormRankingInput,
  options: { model: string },
): Promise<{ output: Stage3RankingOutput; calls: number; retries: number; durationMs: number }> {
  if (input.candidates.length === 0) {
    return { output: { rankings: [] }, calls: 0, retries: 0, durationMs: 0 };
  }

  const result = await runStage3LongFormRankingLlm(input, options);
  assertRankingSuccess("Long-form Ranking", result);
  return rankingMetrics(result);
}

function assertRankingSuccess(
  label: string,
  result: Stage3EventRankingResult | Stage3DigestRankingResult | Stage3LongFormRankingResult,
): asserts result is Extract<typeof result, { success: true }> {
  if (!result.success) {
    throw new Error(`${label} failed: ${result.error}`);
  }
}

function rankingMetrics(result: {
  success: true;
  output: Stage3RankingOutput;
  attempts: number;
  elapsedMs: number;
}): { output: Stage3RankingOutput; calls: number; retries: number; durationMs: number } {
  return {
    output: result.output,
    calls: 1,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
  };
}

function selectTopEvents(options: {
  rankingOutput: Stage3RankingOutput;
  eventInput: Stage3EventRankingInput;
  eventIdMap: Record<string, string[]>;
  topN: number;
}): {
  events: Array<
    Stage3EventRankingInput["events"][number] & {
      rank: number;
      reason: string;
    }
  >;
  idMap: Record<string, string[]>;
} {
  const eventById = new Map(options.eventInput.events.map((event) => [event.id, event]));
  const ranked = [...options.rankingOutput.rankings].sort((left, right) => left.rank - right.rank);
  const selected = ranked.slice(0, options.topN).map((ranking) => {
    const event = eventById.get(ranking.id);
    if (!event) {
      throw new Error(`Event Ranking output references unknown event id ${ranking.id}.`);
    }

    return {
      ...event,
      rank: ranking.rank,
      reason: ranking.reason,
    };
  });

  return {
    events: selected,
    idMap: Object.fromEntries(
      selected.map((event) => [event.id, options.eventIdMap[event.id] ?? []]),
    ),
  };
}

async function buildSelectedEventArticleKeys(
  queryable: Queryable,
  selectedEventIdMap: Record<string, string[]>,
): Promise<{
  artifact: {
    selected_event_count: number;
    selected_event_source_item_count: number;
    unique_selected_article_key_count: number;
    articles: Array<{
      event_id: string;
      processed_content_id: string;
      url: string | null;
      normalized_url: string | null;
    }>;
    unique_keys: string[];
  };
  keyToEventId: Map<string, string>;
}> {
  const processedContentIds = Object.values(selectedEventIdMap).flat();
  const articleUrls = await loadArticleUrls(queryable, processedContentIds);
  const keyToEventId = new Map<string, string>();
  const articles: Array<{
    event_id: string;
    processed_content_id: string;
    url: string | null;
    normalized_url: string | null;
  }> = [];

  for (const [eventId, ids] of Object.entries(selectedEventIdMap)) {
    for (const processedContentId of ids) {
      const url = articleUrls.get(processedContentId) ?? null;
      const normalizedUrl = normalizeArticleUrl(url);
      if (normalizedUrl && !keyToEventId.has(normalizedUrl)) {
        keyToEventId.set(normalizedUrl, eventId);
      }

      articles.push({
        event_id: eventId,
        processed_content_id: processedContentId,
        url,
        normalized_url: normalizedUrl,
      });
    }
  }

  return {
    artifact: {
      selected_event_count: Object.keys(selectedEventIdMap).length,
      selected_event_source_item_count: articles.length,
      unique_selected_article_key_count: keyToEventId.size,
      articles,
      unique_keys: [...keyToEventId.keys()].sort(),
    },
    keyToEventId,
  };
}

async function loadArticleUrls(
  queryable: Queryable,
  processedContentIds: string[],
): Promise<Map<string, string | null>> {
  if (processedContentIds.length === 0) {
    return new Map();
  }

  const result = await queryable.query<{
    processedContentId: string;
    url: string | null;
  }>(
    `
      select
        pc.id as "processedContentId",
        ra.url
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = any($1::uuid[])
    `,
    [processedContentIds],
  );

  return new Map(result.rows.map((row) => [row.processedContentId, row.url]));
}

function applyCrossChannelDedup(options: {
  digestRecords: DigestRecord[];
  longFormRecords: LongFormRecord[];
  selectedKeyToEventId: Map<string, string>;
}): {
  digestRecords: DigestRecord[];
  longFormRecords: LongFormRecord[];
  removed: RemovedByCrossChannel[];
} {
  const removed: RemovedByCrossChannel[] = [];
  const digestRecords = options.digestRecords.filter((record) => {
    const matchedEventId = record.normalizedUrl
      ? options.selectedKeyToEventId.get(record.normalizedUrl)
      : undefined;
    if (!record.normalizedUrl || !matchedEventId) {
      return true;
    }

    removed.push(toCrossChannelRemovedItem("digest", record, matchedEventId));
    return false;
  });
  const longFormRecords = options.longFormRecords.filter((record) => {
    const matchedEventId = record.normalizedUrl
      ? options.selectedKeyToEventId.get(record.normalizedUrl)
      : undefined;
    if (!record.normalizedUrl || !matchedEventId) {
      return true;
    }

    removed.push(toCrossChannelRemovedItem("long_form", record, matchedEventId));
    return false;
  });

  return {
    digestRecords,
    longFormRecords,
    removed,
  };
}

function toCrossChannelRemovedItem(
  channel: "digest" | "long_form",
  record: DigestRecord | LongFormRecord,
  matchedEventId: string,
): RemovedByCrossChannel {
  return {
    channel,
    category: channel === "digest" ? record.category : null,
    id: record.candidate.id,
    title: record.candidate.title,
    processed_content_id: record.processedContentId,
    matched_event_id: matchedEventId,
    normalized_url: record.normalizedUrl ?? "",
    duplicate_reason: CROSS_CHANNEL_DUPLICATE_REASON,
  };
}

function dedupDigestRecords(records: DigestRecord[]): {
  keptRecords: DigestRecord[];
  removedRecords: DigestRecord[];
  duplicateGroups: DigestDuplicateGroup[];
} {
  const recordsByUrl = new Map<string, DigestRecord[]>();
  for (const record of records) {
    if (!record.normalizedUrl) {
      continue;
    }

    const group = recordsByUrl.get(record.normalizedUrl) ?? [];
    group.push(record);
    recordsByUrl.set(record.normalizedUrl, group);
  }

  const removedProcessedContentIds = new Set<string>();
  const duplicateGroups: DigestDuplicateGroup[] = [];

  for (const [normalizedUrl, group] of recordsByUrl.entries()) {
    if (group.length <= 1) {
      continue;
    }

    const winner = chooseDigestWinner(group);
    const removed = group.filter((record) => record !== winner);
    for (const record of removed) {
      removedProcessedContentIds.add(record.processedContentId);
    }

    duplicateGroups.push({
      normalized_url: normalizedUrl,
      kept: toDuplicateItem(winner),
      removed: removed.map((record) => ({
        ...toDuplicateItem(record),
        reason: buildDigestRemovedReason(record, winner),
      })),
      winner_reason: buildDigestWinnerReason(winner, group),
    });
  }

  duplicateGroups.sort((left, right) => left.normalized_url.localeCompare(right.normalized_url));

  return {
    keptRecords: records.filter(
      (record) => !removedProcessedContentIds.has(record.processedContentId),
    ),
    removedRecords: records.filter((record) =>
      removedProcessedContentIds.has(record.processedContentId),
    ),
    duplicateGroups,
  };
}

function chooseDigestWinner(group: DigestRecord[]): DigestRecord {
  return [...group].sort(compareDigestCandidates)[0];
}

function compareDigestCandidates(left: DigestRecord, right: DigestRecord): number {
  const categoryCompare = categoryRank(left.category) - categoryRank(right.category);
  if (categoryCompare !== 0) {
    return categoryCompare;
  }

  const priorityCompare =
    sourcePriorityRank(left.sourcePriority) - sourcePriorityRank(right.sourcePriority);
  if (priorityCompare !== 0) {
    return priorityCompare;
  }

  return left.originalIndex - right.originalIndex;
}

function categoryRank(category: string): number {
  return category === "General" ? 1 : 0;
}

function sourcePriorityRank(priority: string): number {
  switch (priority.trim().toLowerCase()) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

function buildDigestInputs(records: DigestRecord[]): Record<string, Stage3DigestRankingInput> {
  const inputs: Record<string, Stage3DigestRankingInput> = {};
  const categories = [...new Set(records.map((record) => record.category))].sort(compareCategoryNames);

  for (const category of categories) {
    const categoryRecords = records.filter((record) => record.category === category);
    inputs[category] = {
      category,
      candidates: categoryRecords.map((record) => record.candidate),
    };
  }

  return inputs;
}

function buildLongFormInput(records: LongFormRecord[]): Stage3LongFormRankingInput {
  return {
    candidates: records.map((record) => record.candidate),
  };
}

function buildDigestIdMap(records: DigestRecord[]): Record<string, Record<string, string>> {
  const idMap: Record<string, Record<string, string>> = {};
  for (const record of records) {
    idMap[record.category] = idMap[record.category] ?? {};
    idMap[record.category][record.candidate.id] = record.processedContentId;
  }

  return idMap;
}

function buildLongFormIdMap(records: LongFormRecord[]): Record<string, string> {
  return Object.fromEntries(
    records.map((record) => [record.candidate.id, record.processedContentId]),
  );
}

function buildPersistencePlan(options: {
  allDigestRecords: DigestRecord[];
  allLongFormRecords: LongFormRecord[];
  finalDigestIdMap: Record<string, Record<string, string>>;
  finalLongFormIdMap: Record<string, string>;
  digestRankings: Record<string, Stage3RankingOutput>;
  longFormRanking: Stage3RankingOutput;
}): {
  ranked: RankingPersistenceUpdate[];
  staleProcessedContentIds: string[];
} {
  const ranked: RankingPersistenceUpdate[] = [];
  const rankedIds = new Set<string>();

  for (const [category, output] of Object.entries(options.digestRankings)) {
    const categoryIdMap = options.finalDigestIdMap[category] ?? {};
    for (const ranking of output.rankings) {
      const processedContentId = categoryIdMap[ranking.id];
      if (!processedContentId) {
        throw new Error(`Missing digest id-map entry for ${category}/${ranking.id}.`);
      }

      ranked.push({ processedContentId, rank: ranking.rank });
      rankedIds.add(processedContentId);
    }
  }

  for (const ranking of options.longFormRanking.rankings) {
    const processedContentId = options.finalLongFormIdMap[ranking.id];
    if (!processedContentId) {
      throw new Error(`Missing long-form id-map entry for ${ranking.id}.`);
    }

    ranked.push({ processedContentId, rank: ranking.rank });
    rankedIds.add(processedContentId);
  }

  const currentWindowIds = [
    ...options.allDigestRecords.map((record) => record.processedContentId),
    ...options.allLongFormRecords.map((record) => record.processedContentId),
  ];
  const staleProcessedContentIds = currentWindowIds.filter((id) => !rankedIds.has(id));

  return {
    ranked,
    staleProcessedContentIds,
  };
}

function countByCategory(records: DigestRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.category] = (counts[record.category] ?? 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildCategorySummary(
  beforeRecords: DigestRecord[],
  removedRecords: DigestRecord[],
  afterRecords: DigestRecord[],
): Record<string, { before: number; removed: number; after: number }> {
  const categories = new Set([
    ...beforeRecords.map((record) => record.category),
    ...removedRecords.map((record) => record.category),
    ...afterRecords.map((record) => record.category),
  ]);
  return Object.fromEntries(
    [...categories].sort(compareCategoryNames).map((category) => [
      category,
      {
        before: beforeRecords.filter((record) => record.category === category).length,
        removed: removedRecords.filter((record) => record.category === category).length,
        after: afterRecords.filter((record) => record.category === category).length,
      },
    ]),
  );
}

function toDuplicateItem(record: DigestRecord): DuplicateItem {
  return {
    id: record.candidate.id,
    title: record.candidate.title,
    category: record.category,
    source: record.candidate.source,
  };
}

function buildDigestWinnerReason(winner: DigestRecord, group: DigestRecord[]): string {
  const hasGeneral = group.some((record) => record.category === "General");
  const hasSpecific = group.some((record) => record.category !== "General");
  if (hasGeneral && hasSpecific && winner.category !== "General") {
    return "kept more specific category over General";
  }

  const bestPriorityRank = Math.min(
    ...group.map((record) => sourcePriorityRank(record.sourcePriority)),
  );
  if (sourcePriorityRank(winner.sourcePriority) === bestPriorityRank) {
    const priorities = new Set(group.map((record) => sourcePriorityRank(record.sourcePriority)));
    if (priorities.size > 1) {
      return `kept higher source priority (${winner.sourcePriority})`;
    }
  }

  return "kept earliest stable candidate order";
}

function buildDigestRemovedReason(removed: DigestRecord, winner: DigestRecord): string {
  return [
    "same normalized article URL as kept candidate",
    `kept ${winner.category}/${winner.candidate.source}`,
    `removed ${removed.category}/${removed.candidate.source}`,
  ].join("; ");
}

async function writeRunJson(
  path: string,
  value: {
    runId: string;
    sourceStage2RunDir: string;
    startedAt: Date;
    finishedAt: Date;
    model: string;
    status: "success" | "failed";
    collectedWithinHours: number;
    eventGroupCount: number;
    eventSelectedCount: number;
    crossChannelRemovedCount: number;
    digestBeforeDedup: number;
    digestAfterDedup: number;
    digestCategoryCounts: Record<string, number>;
    longFormCount: number;
    llmCallCount: number;
    retryCount: number;
    llmDurationMs: number;
    persistenceStatus: "not_started" | "success" | "failed";
    persistence: Stage3PersistenceResult | null;
    error: string | null;
  },
): Promise<void> {
  await writeJson(path, {
    run_id: value.runId,
    timestamp: value.runId,
    source_stage2_run: value.sourceStage2RunDir,
    status: value.status,
    started_at: value.startedAt.toISOString(),
    finished_at: value.finishedAt.toISOString(),
    model: value.model,
    collected_within_hours: value.collectedWithinHours,
    event_group_count: value.eventGroupCount,
    event_selected_count: value.eventSelectedCount,
    cross_channel_removed_count: value.crossChannelRemovedCount,
    digest_before_dedup: value.digestBeforeDedup,
    digest_after_dedup: value.digestAfterDedup,
    digest_count_by_category: value.digestCategoryCounts,
    long_form_count: value.longFormCount,
    llm_call_count: value.llmCallCount,
    retry_count: value.retryCount,
    llm_duration_ms: value.llmDurationMs,
    persistence_status: value.persistenceStatus,
    persistence: value.persistence,
    error: value.error,
  });
}

function compareCategoryNames(left: string, right: string): number {
  const leftIndex = CATEGORY_ORDER.indexOf(left);
  const rightIndex = CATEGORY_ORDER.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? CATEGORY_ORDER.length : leftIndex) -
      (rightIndex === -1 ? CATEGORY_ORDER.length : rightIndex);
  }

  return left.localeCompare(right);
}

function normalizeRuntimePath(rootDir: string, path: string): string {
  return path.startsWith("/") ? path : join(rootDir, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
