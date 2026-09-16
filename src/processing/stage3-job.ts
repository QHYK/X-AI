/**
 * Stage 3 Workflow job：消费 Stage 2 runtime，完成 Event、Digest 与 Long-form 排名及去重。
 * 该阶段把可复现的输入/诊断写入 runtime；每个独立 Ranking 在自身事务中持久化。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  STAGE3_DIGEST_RANKING_PROMPT_VERSION,
  type Stage3DigestRankingCandidate,
  type Stage3DigestRankingInput,
} from "../prompts/stage3-digest-ranking.js";
import { STAGE3_EVENT_RANKING_PROMPT_VERSION } from "../prompts/stage3-event-ranking.js";
import {
  STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
  type Stage3LongFormRankingInput,
} from "../prompts/stage3-long-form-ranking.js";
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
import type { Stage2Input, Stage2Output } from "./stage2-contract.js";
import type {
  Stage3EventRankedOutput,
  Stage3EventRankingInput,
  Stage3RankingOutput,
} from "./stage3-contract.js";
import {
  deriveStage3EventRankings,
  normalizeStage3EventRankingOutput,
  normalizeStage3RankingOutput,
  parseAndValidateStage3DigestOrderedIdsOutput,
  rebuildStage3DigestRankingFromOrderedIds,
} from "./stage3-contract.js";
import { inferSciencePublication } from "./science-publication.js";
import { resolveStageLlmModel } from "./llm-client.js";
import { normalizeArticleUrl } from "./url-normalization.js";
import type { PublishedAtScope } from "../lib/daily-scope.js";
import { resolveDailyScope } from "../lib/daily-scope.js";
import { DEFAULT_STAGE4_EVENT_LIMIT } from "./stage4-config.js";
import { loadEventGroupsForRanking } from "./event-group-persistence.js";
import {
  buildEventReviewSnapshotItems,
  persistEventReviewSnapshot,
} from "./event-review-persistence.js";

type Queryable = Pick<Pool | PoolClient, "query">;

type Stage2RunArtifact = {
  status?: string;
  model?: string;
  candidate_count?: number;
  event_group_count?: number;
  stage1_run_dir?: string;
  stage1_started_at?: string;
  stage1_finished_at?: string;
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

type Stage3RankingStatus = "pending" | "success" | "failed" | "skipped";

type Stage3RankingStatuses = {
  event: Stage3RankingStatus;
  digest: Stage3RankingStatus;
  long_form: Stage3RankingStatus;
};

type Stage3ResumeArtifact = {
  runDir: string;
  runId: string;
  eventReviewRunId: string;
  hashes: { event: string; digest?: string; longForm?: string };
  statuses: Stage3RankingStatuses;
};

export type Stage3JobOptions = {
  stage2RunDir?: string;
  stage1RunDir?: string;
  publishedWithinHours?: number;
  publishedAtScope?: PublishedAtScope;
  model?: string;
  rootDir?: string;
  dailyDate?: string;
};

export type Stage3JobResult = {
  success: boolean;
  status: "success" | "partial" | "failed";
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
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  persistence: Stage3PersistenceResult | null;
  eventReviewRunId: string | null;
  warningCount: number;
  duplicateRankingCount: number;
  missingRankingCount: number;
  inputSnapshotHashes: { event: string; digest: string; longForm: string } | null;
  rankingStatuses: Stage3RankingStatuses;
};

export function stage3WarningMetrics(result: Pick<Stage3JobResult, "warningCount" | "duplicateRankingCount" | "missingRankingCount">) {
  return {
    warning_count: result.warningCount,
    duplicate_ranking_count: result.duplicateRankingCount,
    missing_ranking_count: result.missingRankingCount,
  };
}

const DEFAULT_LOOKBACK_HOURS = 24;
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

/**
 * 执行 Stage 3，并优先使用 Daily 传入的 Stage 2 run 与其关联的 Stage 1 lineage。
 * 单独运行时仍允许回退到最近成功的 Stage 2 artifact。
 */
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
  const model = resolveStageLlmModel("stage3", options.model);
  const publishedWithinHours = options.publishedWithinHours ?? DEFAULT_LOOKBACK_HOURS;
  const dailyDate = options.dailyDate ?? resolveDailyScope(undefined, startedAt).dailyDate;

  await mkdir(eventsDir, { recursive: true });
  await mkdir(dedupDir, { recursive: true });
  await mkdir(digestDir, { recursive: true });
  await mkdir(longFormDir, { recursive: true });

  let sourceStage2RunDir = "";
  const sourceStage1RunDir = "";
  const stage1StartedAt = "";
  const stage1FinishedAt = "";
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
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let hasMissingTokenUsage = false;
  let persistence: Stage3PersistenceResult | null = null;
  let eventReviewRunId: string | null = null;
  let persistenceStatus: "not_started" | "success" | "failed" = "not_started";
  let rankingStatuses: Stage3RankingStatuses = {
    event: "pending", digest: "pending", long_form: "pending",
  };
  let inputSnapshotHashes: Stage3JobResult["inputSnapshotHashes"] = null;
  let error: string | null = null;
  let warningCount = 0;
  let duplicateRankingCount = 0;
  let missingRankingCount = 0;

  try {
    // Runtime is retained as optional lineage only. DB event_groups is the business input.
    if (options.stage2RunDir) sourceStage2RunDir = options.stage2RunDir;
    const eventBundle = await buildStage3EventRankingInputFromDb(pool, dailyDate);
    eventGroupCount = eventBundle.input.events.length;
    await writeJson(join(eventsDir, "input.json"), eventBundle.input);

    const digestRows = await loadStage3RankingRows(
      pool,
      "digest",
      dailyDate,
    );
    const longFormRows = await loadStage3RankingRows(
      pool,
      "long_form",
      dailyDate,
    );
    const digestRecords = buildDigestRecords(digestRows);
    const longFormRecords = buildLongFormRecords(longFormRows);
    digestBeforeDedup = digestRecords.length;

    const eventHash = snapshotHash(eventBundle.input);
    const resume = await findStage3ResumeArtifact(rootDir, dailyDate, eventHash);
    const reusableEvent = resume && canReuseStage3Ranking(eventHash, resume.hashes.event, resume.statuses.event)
      ? await loadReusableEventRanking(pool, resume, eventBundle.input)
      : null;
    const eventRanking = reusableEvent ?? await rankEvents(eventBundle.input, { model });
    if (reusableEvent) {
      rankingStatuses.event = "skipped";
      eventReviewRunId = resume!.eventReviewRunId;
    } else {
      ({ warningCount, duplicateRankingCount, missingRankingCount } = addRankingWarnings(
        { warningCount, duplicateRankingCount, missingRankingCount }, eventRanking.warnings,
      ));
      llmCallCount += eventRanking.calls;
      retryCount += eventRanking.retries;
      llmDurationMs += eventRanking.durationMs;
      ({ tokenUsage, hasMissingTokenUsage } = addStage3TokenUsage(tokenUsage, hasMissingTokenUsage, eventRanking.tokenUsage));
    }
    await writeJson(join(eventsDir, "ranking-output.json"), eventRanking.output);
    await writeJson(join(eventsDir, "ranking-diagnostics.json"), eventRanking.diagnostics);

    if (!reusableEvent) {
      eventReviewRunId = randomUUID();
      await persistEventReviewSnapshot(
        pool,
        buildEventReviewSnapshotItems({
          reviewRunId: eventReviewRunId,
          dailyDate,
          rankingOutput: eventRanking.output,
          eventInput: eventBundle.input,
          eventIdMap: eventBundle.idMap,
        }),
      );
      rankingStatuses.event = "success";
    }

    const selectedEvents = selectTopEvents({
      rankingOutput: eventRanking.output,
      eventInput: eventBundle.input,
      eventIdMap: eventBundle.idMap,
      topN: DEFAULT_STAGE4_EVENT_LIMIT,
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
    inputSnapshotHashes = {
      event: eventHash,
      digest: snapshotHash(digestInputs),
      longForm: snapshotHash(longFormInput),
    };
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

    const reusableDigest = resume && canReuseStage3Ranking(inputSnapshotHashes.digest, resume.hashes.digest, resume.statuses.digest)
      ? await loadReusableDigestRankings(resume, digestInputs)
      : null;
    const digestRankings: Record<string, Stage3RankingOutput> = reusableDigest ?? {};
    if (reusableDigest) rankingStatuses.digest = "skipped";
    for (const category of reusableDigest ? [] : Object.keys(digestInputs).sort(compareCategoryNames)) {
      const input = digestInputs[category];
      if (!input || input.candidates.length === 0) {
        continue;
      }

      const result = await rankDigest(input, { model });
      ({ warningCount, duplicateRankingCount, missingRankingCount } = addRankingWarnings(
        { warningCount, duplicateRankingCount, missingRankingCount }, result.warnings,
      ));
      llmCallCount += result.calls;
      retryCount += result.retries;
      llmDurationMs += result.durationMs;
      ({ tokenUsage, hasMissingTokenUsage } = addStage3TokenUsage(tokenUsage, hasMissingTokenUsage, result.tokenUsage));
      digestRankings[category] = result.output;
      await writeJson(join(digestDir, `${toSlug(category)}-ranking-output.json`), result.output);
      await writeJson(
        join(digestDir, `${toSlug(category)}-ranking-diagnostics.json`),
        result.diagnostics,
      );
    }

    // Digest and Long-form are independent durable products. Commit the
    // complete, validated Digest set before beginning Long-form work.
    if (!reusableDigest) {
      persistenceStatus = "failed";
      persistence = await persistStage3Plan(pool, buildPersistencePlan({
        allDigestRecords: digestRecords,
        allLongFormRecords: [],
        finalDigestIdMap: idMap.digest,
        finalLongFormIdMap: {},
        digestRankings,
        longFormRanking: { rankings: [] },
      }));
      persistenceStatus = "success";
      rankingStatuses.digest = "success";
    }

    const reusableLongForm = resume && canReuseStage3Ranking(inputSnapshotHashes.longForm, resume.hashes.longForm, resume.statuses.long_form)
      ? await loadReusableLongFormRanking(resume, longFormInput)
      : null;
    const longFormRanking = reusableLongForm ?? await rankLongForm(longFormInput, { model });
    if (reusableLongForm) {
      rankingStatuses.long_form = "skipped";
    } else {
      ({ warningCount, duplicateRankingCount, missingRankingCount } = addRankingWarnings(
        { warningCount, duplicateRankingCount, missingRankingCount }, longFormRanking.warnings,
      ));
      llmCallCount += longFormRanking.calls;
      retryCount += longFormRanking.retries;
      llmDurationMs += longFormRanking.durationMs;
      ({ tokenUsage, hasMissingTokenUsage } = addStage3TokenUsage(tokenUsage, hasMissingTokenUsage, longFormRanking.tokenUsage));
    }
    await writeJson(join(longFormDir, "ranking-output.json"), longFormRanking.output);
    await writeJson(join(longFormDir, "ranking-diagnostics.json"), {
      input_count: longFormInput.candidates.length,
      duplicate_ids: longFormRanking.warnings.duplicateIds,
      missing_ids: longFormRanking.warnings.missingIds,
      rank_normalization_count: longFormRanking.warnings.rankNormalizationCount,
    });

    const persistencePlan = buildPersistencePlan({
      allDigestRecords: [],
      allLongFormRecords: longFormRecords,
      finalDigestIdMap: idMap.digest,
      finalLongFormIdMap: idMap.long_form,
      digestRankings,
      longFormRanking: longFormRanking.output,
    });
    await writeJson(join(runDir, "persistence-plan.json"), persistencePlan);

    if (!reusableLongForm) {
      persistenceStatus = "failed";
      const longFormPersistence = await persistStage3Plan(pool, persistencePlan);
      persistenceStatus = "success";
      persistence = combineStage3Persistence(persistence, longFormPersistence);
      rankingStatuses.long_form = "success";
    }

    await writeRunJson(join(runDir, "run.json"), {
      runId,
      sourceStage2RunDir,
      sourceStage1RunDir,
      stage1StartedAt,
      stage1FinishedAt,
      startedAt,
      finishedAt: new Date(),
      model,
      dailyDate,
      eventReviewRunId,
      status: "success",
      publishedWithinHours,
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
      tokenUsage: hasMissingTokenUsage ? null : tokenUsage,
      persistenceStatus,
      persistence,
      error: null,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      inputSnapshotHashes,
      rankingStatuses,
    });

    return {
      success: true,
      status: "success",
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
      tokenUsage: hasMissingTokenUsage ? null : tokenUsage,
      persistence,
      eventReviewRunId,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      inputSnapshotHashes,
      rankingStatuses,
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    const failedRanking = Object.entries(rankingStatuses).find(([, status]) => status === "pending")?.[0] as keyof Stage3RankingStatuses | undefined;
    if (failedRanking) rankingStatuses = { ...rankingStatuses, [failedRanking]: "failed" };
    // A persistence error is never represented as partial: it is not safe to
    // treat an incomplete database write as a usable product.
    const status = persistenceStatus === "failed"
      ? "failed"
      : Object.values(rankingStatuses).some(isUsableRankingStatus)
        ? "partial"
        : "failed";
    await writeRunJson(join(runDir, "run.json"), {
      runId,
      sourceStage2RunDir,
      sourceStage1RunDir,
      stage1StartedAt,
      stage1FinishedAt,
      startedAt,
      finishedAt: new Date(),
      model,
      dailyDate,
      eventReviewRunId,
      status,
      publishedWithinHours,
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
      tokenUsage: hasMissingTokenUsage ? null : tokenUsage,
      persistenceStatus,
      persistence,
      error,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      inputSnapshotHashes,
      rankingStatuses,
    });

    return {
      success: false,
      status,
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
      tokenUsage: hasMissingTokenUsage ? null : tokenUsage,
      persistence,
      eventReviewRunId,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      inputSnapshotHashes,
      rankingStatuses,
    };
  }
}

/** 加载指定或最近成功的 Stage 2 runtime，建立 Stage 2→3 的可追踪输入 lineage。 */
export async function loadStage2RunForStage3(
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
  if (!stage2RunDirOption && run.status !== "success") {
    throw new Error(`Stage 2 runtime directory is not successful: ${runDir}`);
  }

  const input = await readJson<Stage2Input>(join(runDir, "input.json"));
  const output = await readJson<Stage2Output>(join(runDir, "output.json"));
  const idMap = await readJson<Stage2IdMap>(join(runDir, "id-map.json"));
  // Temporary diagnostic mode: Stage 2 output and assignment validation are
  // intentionally bypassed so incomplete/duplicate groups can feed Stage 3.
  validateStage2IdMap(input, idMap);

  await stat(join(runDir, "output.json"));
  return {
    runDir,
    run,
    input,
    output,
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

export function buildStage3EventRankingInput(
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

/** 从正式 Event Group snapshot 读取 Event Ranking 输入；不依赖 runtime temp id。 */
export async function buildStage3EventRankingInputFromDb(
  queryable: Queryable,
  dailyDate: string,
): Promise<{ input: Stage3EventRankingInput; idMap: Record<string, string[]> }> {
  const rows = await loadEventGroupsForRanking(queryable, dailyDate);
  const groups = new Map<string, {
    event_hint: string;
    sources: Array<{ source: string; title: string; summary: string }>;
    members: string[];
  }>();
  for (const row of rows) {
    const group = groups.get(row.eventGroupId) ?? {
      event_hint: row.eventHint,
      sources: [],
      members: [],
    };
    group.sources.push({ source: row.source, title: row.title, summary: row.summary ?? "" });
    group.members.push(row.processedContentId);
    groups.set(row.eventGroupId, group);
  }
  const events = [...groups.entries()].map(([id, group]) => ({
    id,
    event_hint: group.event_hint,
    source_count: group.sources.length,
    sources: group.sources,
  }));
  return {
    input: { events },
    idMap: Object.fromEntries([...groups.entries()].map(([id, group]) => [id, group.members])),
  };
}

function validateStage2IdMap(input: Stage2Input, idMap: Stage2IdMap) {
  const expectedIds = input.event_candidates.map((candidate) => candidate.temp_id);
  if (Object.keys(idMap).length !== expectedIds.length) {
    throw new Error(
      `Stage 2 id-map entry count ${Object.keys(idMap).length} does not match candidate count ${expectedIds.length}.`,
    );
  }

  const processedContentIds = expectedIds.map((tempId) => {
    const processedContentId = idMap[tempId];
    if (!processedContentId) {
      throw new Error(`Stage 2 id-map is missing processed_content_id for ${tempId}.`);
    }
    return processedContentId;
  });
  if (new Set(processedContentIds).size !== processedContentIds.length) {
    throw new Error("Stage 2 id-map contains duplicate processed_content_id mappings.");
  }
}

/** 读取本次 Stage 1 新产生的 Digest / Long-form 候选。 */
export async function loadStage3RankingRows(
  queryable: Queryable,
  routing: "digest" | "long_form",
  dailyDate: string,
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
        and pc.daily_date = $2::date
      order by
        pc.category,
        pc.created_at asc,
        s.name,
        pc.id
    `,
    [routing, dailyDate],
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
): Promise<{
  output: Stage3EventRankedOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  diagnostics: {
    input_event_count: number;
    returned_ranking_count: number;
    duplicate_ids: string[];
    invalid_ids: string[];
  };
  warnings: { duplicateIds: string[]; missingIds: string[]; rankNormalizationCount: number };
}> {
  if (input.events.length === 0) {
    return {
      output: { rankings: [] },
      calls: 0,
      retries: 0,
      durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      diagnostics: {
        input_event_count: 0,
        returned_ranking_count: 0,
        duplicate_ids: [],
        invalid_ids: [],
      },
      warnings: { duplicateIds: [], missingIds: [], rankNormalizationCount: 0 },
    };
  }

  const result = await runStage3EventRankingLlm(input, options);
  assertRankingSuccess("Event Ranking", result);
  return {
    output: result.rankings,
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
    diagnostics: {
      input_event_count: input.events.length,
      returned_ranking_count: result.rankings.rankings.length,
      duplicate_ids: result.assignment.duplicateIds,
      invalid_ids: result.assignment.inventedIds,
    },
    warnings: result.warnings,
  };
}

async function rankDigest(
  input: Stage3DigestRankingInput,
  options: { model: string },
): Promise<{
  output: Stage3RankingOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  diagnostics: {
    category: string;
    input_count: number;
    returned_count: number;
    missing_count: number;
    duplicate_ids: string[];
    invalid_ids: string[];
    repair_attempted: boolean;
    repair_success: boolean | null;
    repaired_count: number | null;
    repair_missing_ids: string[];
    repair_duplicate_ids: string[];
    repair_invalid_ids: string[];
    initial_finish_reason: string | null;
    initial_input_tokens: number | null;
    initial_output_tokens: number | null;
    initial_total_tokens: number | null;
    initial_returned_count: number | null;
    initial_unique_valid_ids: number | null;
    initial_duration_ms: number;
    repair_finish_reason: string | null;
    repair_input_tokens: number | null;
    repair_output_tokens: number | null;
    repair_total_tokens: number | null;
    repair_ranked_candidates_count: number | null;
    repair_missing_candidates_count: number | null;
    repair_returned_count: number | null;
    repair_duration_ms: number | null;
  };
  warnings: { duplicateIds: string[]; missingIds: string[]; rankNormalizationCount: number };
}> {
  const result = await runStage3DigestRankingLlm(input, options);
  if (!result.success) {
    const parsed = result.rawOutputText
      ? parseAndValidateStage3DigestOrderedIdsOutput(result.rawOutputText)
      : null;
    const recovered = parsed?.success
      ? normalizeStage3RankingOutput(
        rebuildStage3DigestRankingFromOrderedIds(parsed.output.ordered_ids),
        input.candidates.map((candidate) => candidate.id),
      )
      : null;
    if (!recovered?.success) {
      assertRankingSuccess(`Digest Ranking (${input.category})`, result);
      throw new Error(`Digest Ranking (${input.category}) failed without a recoverable ranking output.`);
    }
    const initialDiag = result.diagnostics.initial;
    const repairDiag = result.diagnostics.repair;
    return {
      output: recovered.output,
      calls: result.attempts,
      retries: Math.max(0, result.attempts - 1),
      durationMs: result.elapsedMs,
      tokenUsage: sumKnownStage3TokenUsages([
        toStage3TokenUsage(initialDiag.input_tokens, initialDiag.output_tokens, initialDiag.total_tokens),
        repairDiag ? toStage3TokenUsage(repairDiag.input_tokens, repairDiag.output_tokens, repairDiag.total_tokens) : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ]),
      diagnostics: {
        category: input.category, input_count: input.candidates.length,
        returned_count: initialDiag.returned_count ?? 0, missing_count: initialDiag.missing_count ?? 0,
        duplicate_ids: result.assignment?.duplicateIds ?? [], invalid_ids: result.assignment?.inventedIds ?? [],
        repair_attempted: result.repair?.attempted ?? false, repair_success: result.repair?.success ?? null,
        repaired_count: recovered.output.rankings.length, repair_missing_ids: [], repair_duplicate_ids: [], repair_invalid_ids: [],
        initial_finish_reason: initialDiag.finish_reason, initial_input_tokens: initialDiag.input_tokens,
        initial_output_tokens: initialDiag.output_tokens, initial_total_tokens: initialDiag.total_tokens,
        initial_returned_count: initialDiag.returned_count, initial_unique_valid_ids: initialDiag.unique_valid_ids,
        initial_duration_ms: initialDiag.duration_ms, repair_finish_reason: repairDiag?.finish_reason ?? null,
        repair_input_tokens: repairDiag?.input_tokens ?? null, repair_output_tokens: repairDiag?.output_tokens ?? null,
        repair_total_tokens: repairDiag?.total_tokens ?? null, repair_ranked_candidates_count: repairDiag?.ranked_candidates_count ?? null,
        repair_missing_candidates_count: repairDiag?.missing_candidates_count ?? null, repair_returned_count: repairDiag?.returned_count ?? null,
        repair_duration_ms: repairDiag?.duration_ms ?? null,
      },
      warnings: recovered.warnings,
    };
  }
  assertRankingSuccess(`Digest Ranking (${input.category})`, result);
  const repaired = result.repair.after;
  const initialDiag = result.diagnostics.initial;
  const repairDiag = result.diagnostics.repair;
  return {
    output: result.output,
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage: sumKnownStage3TokenUsages([
      toStage3TokenUsage(initialDiag.input_tokens, initialDiag.output_tokens, initialDiag.total_tokens),
      repairDiag ? toStage3TokenUsage(repairDiag.input_tokens, repairDiag.output_tokens, repairDiag.total_tokens) : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ]),
    diagnostics: {
      category: input.category,
      input_count: input.candidates.length,
      returned_count: result.repair.beforeReturnedCount,
      missing_count: result.repair.before.missingIds.length,
      duplicate_ids: result.repair.before.duplicateIds,
      invalid_ids: result.repair.before.inventedIds,
      repair_attempted: result.repair.attempted,
      repair_success: result.repair.success,
      repaired_count: repaired ? result.output.rankings.length : null,
      repair_missing_ids: repaired ? repaired.missingIds : [],
      repair_duplicate_ids: repaired ? repaired.duplicateIds : [],
      repair_invalid_ids: repaired ? repaired.inventedIds : [],
      initial_finish_reason: initialDiag.finish_reason,
      initial_input_tokens: initialDiag.input_tokens,
      initial_output_tokens: initialDiag.output_tokens,
      initial_total_tokens: initialDiag.total_tokens,
      initial_returned_count: initialDiag.returned_count,
      initial_unique_valid_ids: initialDiag.unique_valid_ids,
      initial_duration_ms: initialDiag.duration_ms,
      repair_finish_reason: repairDiag?.finish_reason ?? null,
      repair_input_tokens: repairDiag?.input_tokens ?? null,
      repair_output_tokens: repairDiag?.output_tokens ?? null,
      repair_total_tokens: repairDiag?.total_tokens ?? null,
      repair_ranked_candidates_count: repairDiag?.ranked_candidates_count ?? null,
      repair_missing_candidates_count: repairDiag?.missing_candidates_count ?? null,
      repair_returned_count: repairDiag?.returned_count ?? null,
      repair_duration_ms: repairDiag?.duration_ms ?? null,
    },
    warnings: {
      duplicateIds: result.repair.before.duplicateIds,
      missingIds: result.repair.before.missingIds,
      rankNormalizationCount: 0,
    },
  };
}

async function rankLongForm(
  input: Stage3LongFormRankingInput,
  options: { model: string },
): Promise<{ output: Stage3RankingOutput; calls: number; retries: number; durationMs: number; tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null; warnings: { duplicateIds: string[]; missingIds: string[]; rankNormalizationCount: number } }> {
  if (input.candidates.length === 0) {
    return { output: { rankings: [] }, calls: 0, retries: 0, durationMs: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: { duplicateIds: [], missingIds: [], rankNormalizationCount: 0 } };
  }

  const result = await runStage3LongFormRankingLlm(input, options);
  assertRankingSuccess("Long-form Ranking", result);
  return { ...rankingMetrics(result), warnings: result.warnings };
}

function addRankingWarnings(
  current: { warningCount: number; duplicateRankingCount: number; missingRankingCount: number },
  warnings: { duplicateIds: string[]; missingIds: string[]; rankNormalizationCount: number },
) {
  return {
    warningCount: current.warningCount + warnings.duplicateIds.length + warnings.missingIds.length + warnings.rankNormalizationCount,
    duplicateRankingCount: current.duplicateRankingCount + warnings.duplicateIds.length,
    missingRankingCount: current.missingRankingCount + warnings.missingIds.length,
  };
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
  tokenUsage: Stage3TokenUsage | null;
}): { output: Stage3RankingOutput; calls: number; retries: number; durationMs: number; tokenUsage: Stage3TokenUsage | null } {
  return {
    output: result.output,
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
  };
}

type Stage3TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

function addStage3TokenUsage(current: Stage3TokenUsage, missing: boolean, next: Stage3TokenUsage | null): { tokenUsage: Stage3TokenUsage; hasMissingTokenUsage: boolean } {
  if (next === null) return { tokenUsage: current, hasMissingTokenUsage: true };
  return { tokenUsage: { inputTokens: current.inputTokens + next.inputTokens, outputTokens: current.outputTokens + next.outputTokens, totalTokens: current.totalTokens + next.totalTokens }, hasMissingTokenUsage: missing };
}

function toStage3TokenUsage(inputTokens: number | null, outputTokens: number | null, totalTokens: number | null): Stage3TokenUsage | null {
  return inputTokens === null || outputTokens === null || totalTokens === null ? null : { inputTokens, outputTokens, totalTokens };
}

function sumKnownStage3TokenUsages(values: Array<Stage3TokenUsage | null>): Stage3TokenUsage | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Stage3TokenUsage>((sum, value) => ({ inputTokens: sum.inputTokens + value!.inputTokens, outputTokens: sum.outputTokens + value!.outputTokens, totalTokens: sum.totalTokens + value!.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

export function selectTopEvents(options: {
  rankingOutput: Stage3EventRankedOutput;
  eventInput: Stage3EventRankingInput;
  eventIdMap: Record<string, string[]>;
  topN: number;
}): {
  events: Array<
    Stage3EventRankingInput["events"][number] & {
      rank: number;
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

/**
 * 移除与已选 Top Event 指向同一规范化 URL 的 Digest/Long-form。
 * 这样最终 Brief 不会在多个频道重复呈现同一篇原始报道。
 */
export function applyCrossChannelDedup(options: {
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

async function persistStage3Plan(pool: Pool, plan: ReturnType<typeof buildPersistencePlan>): Promise<Stage3PersistenceResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await persistStage3Ranks(client, plan);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function combineStage3Persistence(
  left: Stage3PersistenceResult | null,
  right: Stage3PersistenceResult,
): Stage3PersistenceResult {
  return {
    rankedUpdated: (left?.rankedUpdated ?? 0) + right.rankedUpdated,
    staleCleared: (left?.staleCleared ?? 0) + right.staleCleared,
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
    sourceStage1RunDir: string;
    stage1StartedAt: string;
    stage1FinishedAt: string;
    startedAt: Date;
    finishedAt: Date;
    model: string;
    dailyDate: string;
    eventReviewRunId: string | null;
    status: "success" | "partial" | "failed";
    publishedWithinHours: number;
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
    tokenUsage: Stage3TokenUsage | null;
    persistenceStatus: "not_started" | "success" | "failed";
    persistence: Stage3PersistenceResult | null;
    error: string | null;
    warningCount: number;
    duplicateRankingCount: number;
    missingRankingCount: number;
    inputSnapshotHashes: Stage3JobResult["inputSnapshotHashes"];
    rankingStatuses: Stage3RankingStatuses;
  },
): Promise<void> {
  await writeJson(path, {
    run_id: value.runId,
    timestamp: value.runId,
    source_stage2_run: value.sourceStage2RunDir,
    source_stage1_run: value.sourceStage1RunDir,
    stage1_started_at: value.stage1StartedAt,
    stage1_finished_at: value.stage1FinishedAt,
    status: value.status,
    started_at: value.startedAt.toISOString(),
    finished_at: value.finishedAt.toISOString(),
    model: value.model,
    daily_date: value.dailyDate,
    event_review_run_id: value.eventReviewRunId,
    prompt_versions: {
      event: STAGE3_EVENT_RANKING_PROMPT_VERSION,
      digest: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
      long_form: STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
    },
    published_within_hours: value.publishedWithinHours,
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
    input_tokens: value.tokenUsage?.inputTokens ?? null,
    output_tokens: value.tokenUsage?.outputTokens ?? null,
    total_tokens: value.tokenUsage?.totalTokens ?? null,
    persistence_status: value.persistenceStatus,
    persistence: value.persistence,
    warning_count: value.warningCount,
    duplicate_ranking_count: value.duplicateRankingCount,
    missing_ranking_count: value.missingRankingCount,
    input_snapshot_hashes: value.inputSnapshotHashes && {
      event: value.inputSnapshotHashes.event,
      digest: value.inputSnapshotHashes.digest,
      long_form: value.inputSnapshotHashes.longForm,
    },
    ranking_statuses: value.rankingStatuses,
    error: value.error,
  });
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isUsableRankingStatus(status: Stage3RankingStatus): boolean {
  return status === "success" || status === "skipped";
}

/** A persisted sub-ranking can resume only against the exact same input snapshot. */
export function canReuseStage3Ranking(
  currentInputHash: string,
  persistedInputHash: string | undefined,
  persistedStatus: Stage3RankingStatus,
): boolean {
  return currentInputHash === persistedInputHash && isUsableRankingStatus(persistedStatus);
}

async function findStage3ResumeArtifact(
  rootDir: string,
  dailyDate: string,
  eventHash: string,
): Promise<Stage3ResumeArtifact | null> {
  const root = join(rootDir, "runtime/stage3");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const run = await readJson<Record<string, unknown>>(join(root, entry.name, "run.json"));
      const hashes = run.input_snapshot_hashes as Record<string, unknown> | undefined;
      const statuses = run.ranking_statuses as Partial<Record<keyof Stage3RankingStatuses, unknown>> | undefined;
      if (run.daily_date !== dailyDate || hashes?.event !== eventHash || typeof run.event_review_run_id !== "string") continue;
      const event = rankingStatus(statuses?.event);
      const digest = rankingStatus(statuses?.digest);
      const longForm = rankingStatus(statuses?.long_form);
      if (!event || !digest || !longForm) continue;
      return {
        runDir: join(root, entry.name), runId: typeof run.run_id === "string" ? run.run_id : entry.name,
        eventReviewRunId: run.event_review_run_id,
        hashes: {
          event: hashes.event,
          digest: typeof hashes.digest === "string" ? hashes.digest : undefined,
          longForm: typeof hashes.long_form === "string" ? hashes.long_form : undefined,
        },
        statuses: { event, digest, long_form: longForm },
      };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return null;
}

function rankingStatus(value: unknown): Stage3RankingStatus | null {
  return value === "pending" || value === "success" || value === "failed" || value === "skipped" ? value : null;
}

async function loadReusableEventRanking(
  pool: Pool,
  resume: Stage3ResumeArtifact,
  input: Stage3EventRankingInput,
): Promise<Awaited<ReturnType<typeof rankEvents>> | null> {
  const snapshot = await pool.query<{ count: string }>(
    "select count(*)::text as count from event_review_items where review_run_id=$1::uuid",
    [resume.eventReviewRunId],
  );
  if (Number(snapshot.rows[0]?.count ?? 0) === 0) return null;
  try {
    const output = await readJson<Stage3EventRankedOutput>(join(resume.runDir, "events/ranking-output.json"));
    const normalized = normalizeStage3EventRankingOutput(
      { ordered_ids: output.rankings.map((item) => item.id) }, input.events.map((event) => event.id),
    );
    if (!normalized.success) return null;
    return {
      output: deriveStage3EventRankings(normalized.output), calls: 0, retries: 0, durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      diagnostics: { input_event_count: input.events.length, returned_ranking_count: output.rankings.length, duplicate_ids: [], invalid_ids: [] },
      warnings: { duplicateIds: [], missingIds: [], rankNormalizationCount: 0 },
    };
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function loadReusableDigestRankings(
  resume: Stage3ResumeArtifact,
  inputs: Record<string, Stage3DigestRankingInput>,
): Promise<Record<string, Stage3RankingOutput> | null> {
  try {
    const rankings: Record<string, Stage3RankingOutput> = {};
    for (const input of Object.values(inputs)) {
      if (input.candidates.length === 0) continue;
      const output = await readJson<Stage3RankingOutput>(join(resume.runDir, "digest", `${toSlug(input.category)}-ranking-output.json`));
      const normalized = normalizeStage3RankingOutput(output, input.candidates.map((candidate) => candidate.id));
      if (!normalized.success) return null;
      rankings[input.category] = normalized.output;
    }
    return rankings;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function loadReusableLongFormRanking(
  resume: Stage3ResumeArtifact,
  input: Stage3LongFormRankingInput,
): Promise<Awaited<ReturnType<typeof rankLongForm>> | null> {
  try {
    const output = await readJson<Stage3RankingOutput>(join(resume.runDir, "long-form/ranking-output.json"));
    const normalized = normalizeStage3RankingOutput(output, input.candidates.map((candidate) => candidate.id));
    if (!normalized.success) return null;
    return {
      output: normalized.output, calls: 0, retries: 0, durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: { duplicateIds: [], missingIds: [], rankNormalizationCount: 0 },
    };
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
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
