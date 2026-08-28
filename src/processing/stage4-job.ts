/**
 * Stage 4 Workflow job：读取 Stage 3 选中的 Event、执行 enrichment，并重建最终 events。
 * Daily 运行传入本次 Stage 3 runtime，单独运行才回退到最近成功 artifact。
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION } from "../prompts/stage4-event-enrichment.js";
import { resolveStageLlmModel } from "./llm-client.js";
import {
  enrichStage4Event,
  loadStage4SourceCandidates,
  prepareStage4Event,
  type EnrichedStage4Event,
  Stage4EnrichmentError,
} from "./stage4-event-processing.js";
import {
  persistStage4Events,
  type Stage4EventToPersist,
  type Stage4PersistenceResult,
} from "./stage4-persistence.js";

type Stage3RunArtifact = {
  status?: string;
  event_review_run_id?: string | null;
};

type SelectedStage3Event = {
  id: string;
  event_hint: string;
  source_count: number;
  sources: Array<{
    source: string;
    title: string;
    summary: string;
  }>;
  rank: number;
  reason: string;
};

type Stage3SelectedEventsArtifact = {
  events: SelectedStage3Event[];
  idMap: Record<string, string[]>;
};

type PreviousStage4PersistenceArtifact = {
  created_event_ids?: string[];
  event_group_to_event_id?: Record<string, string>;
};

type PreviousStage4PersistencePlanArtifact = {
  events?: Array<{
    event_group_id?: string;
    event_date?: string;
  }>;
};

export type Stage4JobOptions = {
  stage3RunDir?: string;
  concurrency?: number;
  model?: string;
  rootDir?: string;
};

export type Stage4JobResult = {
  success: boolean;
  runDir: string;
  sourceStage3RunDir: string | null;
  selectedEventCount: number;
  enrichmentSuccessCount: number;
  llmCalls: number;
  retryCount: number;
  llmDurationMs: number;
  webSearchEventCount: number;
  totalWebSearchCalls: number;
  eventsCreated: number;
  processedContentEventIdUpdated: number;
  associationCoverage: {
    expected: number;
    updated: number;
    duplicateProcessedContentIds: number;
  };
  persistence: Stage4PersistenceResult | null;
  error: string | null;
};

const DEFAULT_STAGE4_CONCURRENCY = 3;

/** 执行 Event enrichment、写入完整 runtime，并在事务中持久化本次重建结果。 */
export async function processStage4(
  pool: Pool,
  options: Stage4JobOptions = {},
): Promise<Stage4JobResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const startedAt = new Date();
  const runId = toRunTimestamp(startedAt);
  const runDir = join(rootDir, "runtime/stage4", runId);
  const eventsDir = join(runDir, "events");
  const runPath = join(runDir, "run.json");
  const model = resolveStageLlmModel("stage4", options.model);
  const concurrency = options.concurrency ?? DEFAULT_STAGE4_CONCURRENCY;

  await mkdir(eventsDir, { recursive: true });

  let sourceStage3RunDir: string | null = null;
  let selectedEventCount = 0;
  let enrichmentSuccessCount = 0;
  let llmCalls = 0;
  let retryCount = 0;
  let llmDurationMs = 0;
  let webSearchEventCount = 0;
  let totalWebSearchCalls = 0;
  let eventsCreated = 0;
  let processedContentEventIdUpdated = 0;
  let associationCoverage = {
    expected: 0,
    updated: 0,
    duplicateProcessedContentIds: 0,
  };
  let persistence: Stage4PersistenceResult | null = null;
  let persistenceStatus: "not_started" | "success" | "failed" = "not_started";
  let error: string | null = null;

  try {
    sourceStage3RunDir = await loadLatestSuccessfulStage3RunDir(rootDir, options.stage3RunDir);
    const stage3Run = await readJson<Stage3RunArtifact>(join(sourceStage3RunDir, "run.json"));
    const selected = await readJson<Stage3SelectedEventsArtifact>(
      join(sourceStage3RunDir, "events/selected.json"),
    );
    selectedEventCount = selected.events.length;
    await writeJson(join(runDir, "selected-events.json"), selected);

    const allProcessedContentIds = Object.values(selected.idMap).flat();
    associationCoverage.expected = allProcessedContentIds.length;
    associationCoverage.duplicateProcessedContentIds =
      allProcessedContentIds.length - new Set(allProcessedContentIds).size;

    const reviewItemIds = await loadEventReviewItemIds(
      pool,
      stage3Run.event_review_run_id ?? null,
      selected.events.map((event) => event.id),
    );
    const sourceCandidates = await loadStage4SourceCandidates(pool, allProcessedContentIds);
    const eventInputs = selected.events.map((event) =>
      prepareStage4Event(
        {
          eventGroupId: event.id,
          eventReviewItemId: reviewItemIds.get(event.id) ?? null,
          eventHint: event.event_hint,
          aiRank: event.rank,
          displayRank: event.rank,
          processedContentIds: selected.idMap[event.id] ?? [],
        },
        sourceCandidates,
        startedAt,
      ),
    );

    for (const item of eventInputs) {
      const eventDir = join(eventsDir, item.group.eventGroupId);
      await mkdir(eventDir, { recursive: true });
      await writeJson(join(eventDir, "input.json"), item.input);
      await writeJson(join(eventDir, "mapping.json"), {
        event_group_id: item.group.eventGroupId,
        event_review_item_id: item.group.eventReviewItemId,
        rank: item.group.displayRank,
        event_date: item.eventDate.eventDate,
        event_date_source: item.eventDate.source,
        published_at_values: item.publishedAtValues.map((value) => value?.toISOString() ?? null),
        processed_content_ids: item.group.processedContentIds,
      });
    }

    const enriched = await mapWithConcurrency(eventInputs, concurrency, async (item) => {
      const eventDir = join(eventsDir, item.group.eventGroupId);
      try {
        const result = await enrichStage4Event(item, { model });
        llmCalls += 1;
        retryCount += result.llm.attempts - 1;
        llmDurationMs += result.llm.elapsedMs;
        await writeJson(join(eventDir, "output.json"), result.output);
        await writeJson(join(eventDir, "raw-output.json"), result.llm.rawStructuredOutput);
        await writeJson(join(eventDir, "tool-usage.json"), result.toolUsage);
        return result;
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        if (caught instanceof Stage4EnrichmentError) {
          llmCalls += 1;
          retryCount += Math.max(0, caught.attempts - 1);
          llmDurationMs += caught.elapsedMs;
        }
        await writeJson(join(eventDir, "failure.json"), {
          error,
          attempts: caught instanceof Stage4EnrichmentError ? caught.attempts : null,
          raw_output_text: caught instanceof Stage4EnrichmentError ? caught.rawOutputText : null,
        });
        throw caught;
      }
    });

    enrichmentSuccessCount = enriched.length;
    webSearchEventCount = enriched.filter((event) => event.toolUsage.webSearchPerformed).length;
    totalWebSearchCalls = enriched.reduce(
      (sum, event) => sum + event.toolUsage.webSearchCallCount,
      0,
    );
    const rebuildEventDates = uniqueSorted(
      enriched.map((event) => event.eventDate.eventDate),
    );
    const previousCreatedEventIds = await loadPreviousCreatedEventIds(
      rootDir,
      runDir,
      rebuildEventDates,
    );
    const persistencePlan = {
      previousCreatedEventIds,
      events: enriched.map(toEventToPersist),
    };
    await writeJson(join(runDir, "persistence-plan.json"), {
      rebuild_event_dates: rebuildEventDates,
      previous_created_event_ids: previousCreatedEventIds,
      events: persistencePlan.events.map((event) => ({
        event_group_id: event.eventGroupId,
        event_review_item_id: event.eventReviewItemId,
        processed_content_ids: event.processedContentIds,
        ai_rank: event.aiRank,
        display_rank: event.displayRank,
        event_date: event.eventDate,
      })),
    });

    persistenceStatus = "failed";
    const client = await pool.connect();
    try {
      await client.query("begin");
      persistence = await persistStage4Events(client, persistencePlan);
      await client.query("commit");
      persistenceStatus = "success";
    } catch (caught) {
      await client.query("rollback");
      throw caught;
    } finally {
      client.release();
    }

    eventsCreated = persistence.createdEventIds.length;
    processedContentEventIdUpdated = persistence.associations.reduce(
      (sum, association) => sum + association.updated_count,
      0,
    );
    associationCoverage = {
      ...associationCoverage,
      updated: processedContentEventIdUpdated,
    };
    await writeJson(join(runDir, "persistence.json"), {
      created_event_ids: persistence.createdEventIds,
      event_group_to_event_id: persistence.eventGroupToEventId,
      associations: persistence.associations,
      previous_unlinked_count: persistence.previousUnlinkedCount,
      previous_deleted_count: persistence.previousDeletedCount,
      cleanup_event_count: persistence.cleanupEventCount,
      cleanup_event_dates: persistence.cleanupEventDates,
    });

    await writeRunJson(runPath, {
      runId,
      sourceStage3RunDir,
      startedAt,
      finishedAt: new Date(),
      model,
      concurrency,
      status: "success",
      selectedEventCount,
      enrichmentSuccessCount,
      llmCalls,
      retryCount,
      llmDurationMs,
      webSearchEventCount,
      totalWebSearchCalls,
      eventsCreated,
      processedContentEventIdUpdated,
      associationCoverage,
      persistenceStatus,
      persistence,
      error: null,
    });

    return {
      success: true,
      runDir,
      sourceStage3RunDir,
      selectedEventCount,
      enrichmentSuccessCount,
      llmCalls,
      retryCount,
      llmDurationMs,
      webSearchEventCount,
      totalWebSearchCalls,
      eventsCreated,
      processedContentEventIdUpdated,
      associationCoverage,
      persistence,
      error: null,
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await writeRunJson(runPath, {
      runId,
      sourceStage3RunDir,
      startedAt,
      finishedAt: new Date(),
      model,
      concurrency,
      status: "failed",
      selectedEventCount,
      enrichmentSuccessCount,
      llmCalls,
      retryCount,
      llmDurationMs,
      webSearchEventCount,
      totalWebSearchCalls,
      eventsCreated,
      processedContentEventIdUpdated,
      associationCoverage,
      persistenceStatus,
      persistence,
      error,
    });

    return {
      success: false,
      runDir,
      sourceStage3RunDir,
      selectedEventCount,
      enrichmentSuccessCount,
      llmCalls,
      retryCount,
      llmDurationMs,
      webSearchEventCount,
      totalWebSearchCalls,
      eventsCreated,
      processedContentEventIdUpdated,
      associationCoverage,
      persistence,
      error,
    };
  }
}

/** 解析明确 lineage，或在独立执行时查找最近成功的 Stage 3 run。 */
async function loadLatestSuccessfulStage3RunDir(
  rootDir: string,
  stage3RunDirOption?: string,
): Promise<string> {
  if (stage3RunDirOption) {
    const runDir = stage3RunDirOption.startsWith("/")
      ? stage3RunDirOption
      : join(rootDir, stage3RunDirOption);
    await assertSuccessfulStage3Run(runDir);
    return runDir;
  }

  const root = join(rootDir, "runtime/stage3");
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    try {
      await assertSuccessfulStage3Run(candidate);
      return candidate;
    } catch (caught) {
      if (!isMissingPathError(caught)) {
        throw caught;
      }
    }
  }

  throw new Error(`No successful Stage 3 run found under ${root}.`);
}

async function assertSuccessfulStage3Run(runDir: string): Promise<void> {
  const run = await readJson<Stage3RunArtifact>(join(runDir, "run.json"));
  if (run.status !== "success") {
    throw new Error(`Stage 3 run is not successful: ${runDir}`);
  }

  await stat(join(runDir, "events/selected.json"));
}

/**
 * 新 Stage 3 runtime 会携带 snapshot UUID；据此把选中的 temp id 映射为稳定的 Review item ID。
 * 旧 artifact 不具备此字段时返回空映射，保留 migration 前数据的兼容路径。
 */
async function loadEventReviewItemIds(
  pool: Pool,
  reviewRunId: string | null,
  eventTempIds: string[],
): Promise<Map<string, string>> {
  if (!reviewRunId || eventTempIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<{ id: string; event_temp_id: string }>(
    `
      select id, event_temp_id
      from event_review_items
      where review_run_id = $1::uuid
        and event_temp_id = any($2::text[])
    `,
    [reviewRunId, eventTempIds],
  );
  const ids = new Map(result.rows.map((row) => [row.event_temp_id, row.id]));
  if (ids.size !== eventTempIds.length) {
    throw new Error("Stage 3 Review snapshot is missing one or more selected Event Groups.");
  }
  return ids;
}

/**
 * 收集同一 event_date 范围的旧 Event ID 以供重建清理。
 * 只从成功 run 的 persistence plan 取 ID，避免扩展到无关历史 Event。
 */
async function loadPreviousCreatedEventIds(
  rootDir: string,
  currentRunDir: string,
  rebuildEventDates: string[],
): Promise<string[]> {
  if (rebuildEventDates.length === 0) {
    return [];
  }

  const root = join(rootDir, "runtime/stage4");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return [];
    }

    throw caught;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => path !== currentRunDir)
    .sort()
    .reverse();

  const eventIds = new Set<string>();
  for (const candidate of candidates) {
    try {
      const run = await readJson<{ status?: string }>(join(candidate, "run.json"));
      const persistence = await readJson<PreviousStage4PersistenceArtifact>(
        join(candidate, "persistence.json"),
      );
      if (run.status === "success" && Array.isArray(persistence.created_event_ids)) {
        const scopedIds = await loadScopedPreviousCreatedEventIds(
          candidate,
          persistence,
          rebuildEventDates,
        );
        scopedIds.forEach((id) => eventIds.add(id));
      }
    } catch (caught) {
      if (!isMissingPathError(caught)) {
        throw caught;
      }
    }
  }

  return [...eventIds];
}

async function loadScopedPreviousCreatedEventIds(
  runDir: string,
  persistence: PreviousStage4PersistenceArtifact,
  rebuildEventDates: string[],
): Promise<string[]> {
  const plan = await readJson<PreviousStage4PersistencePlanArtifact>(
    join(runDir, "persistence-plan.json"),
  );
  const eventGroupToEventId = persistence.event_group_to_event_id ?? {};
  const ids: string[] = [];

  for (const event of plan.events ?? []) {
    if (!event.event_group_id || !event.event_date) {
      continue;
    }
    if (!rebuildEventDates.includes(event.event_date)) {
      continue;
    }

    const eventId = eventGroupToEventId[event.event_group_id];
    if (eventId) {
      ids.push(eventId);
    }
  }

  return ids;
}

function toEventToPersist(enriched: EnrichedStage4Event): Stage4EventToPersist {
  return {
    eventGroupId: enriched.group.eventGroupId,
    eventReviewItemId: enriched.group.eventReviewItemId,
    processedContentIds: enriched.group.processedContentIds,
    aiRank: enriched.group.aiRank,
    displayRank: enriched.group.displayRank,
    eventDate: enriched.eventDate.eventDate,
    output: enriched.output,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await handler(items[currentIndex]);
      }
    }),
  );

  return results;
}

async function writeRunJson(
  path: string,
  value: {
    runId: string;
    sourceStage3RunDir: string | null;
    startedAt: Date;
    finishedAt: Date;
    model: string;
    concurrency: number;
    status: "success" | "failed";
    selectedEventCount: number;
    enrichmentSuccessCount: number;
    llmCalls: number;
    retryCount: number;
    llmDurationMs: number;
    webSearchEventCount: number;
    totalWebSearchCalls: number;
    eventsCreated: number;
    processedContentEventIdUpdated: number;
    associationCoverage: {
      expected: number;
      updated: number;
      duplicateProcessedContentIds: number;
    };
    persistenceStatus: "not_started" | "success" | "failed";
    persistence: Stage4PersistenceResult | null;
    error: string | null;
  },
): Promise<void> {
  await writeJson(path, {
    run_id: value.runId,
    timestamp: value.runId,
    stage: "stage4",
    source_stage3_run: value.sourceStage3RunDir,
    status: value.status,
    started_at: value.startedAt.toISOString(),
    finished_at: value.finishedAt.toISOString(),
    model: value.model,
    prompt_version: STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
    concurrency: value.concurrency,
    selected_event_count: value.selectedEventCount,
    enrichment_success_count: value.enrichmentSuccessCount,
    llm_calls: value.llmCalls,
    retry_count: value.retryCount,
    llm_duration_ms: value.llmDurationMs,
    web_search_event_count: value.webSearchEventCount,
    total_web_search_calls: value.totalWebSearchCalls,
    events_created: value.eventsCreated,
    processed_contents_event_id_updated: value.processedContentEventIdUpdated,
    association_coverage: value.associationCoverage,
    persistence_status: value.persistenceStatus,
    persistence: value.persistence,
    error: value.error,
  });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
