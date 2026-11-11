import { reusableEventCheckpoint, reusableLongFormCheckpoint } from './stage3-ranking-recovery.js';
import { getActiveMemories, formatMemories } from '../lib/memories.js';
import {
  stage3Checkpoints,
  writeStage3Step,
  restoreStage3Prompt,
  stage3Hash,
  stage3Error,
  type Stage3Step,
  type Stage3Section,
} from './stage3-progress.js';
import {
  consolidateDigestCategory,
  ConsolidationPersistenceError,
} from './stage3-consolidation.js';
import { runStage3Consolidation } from './stage3-consolidation-llm.js';
import { resolveStageLlmProvider } from './llm-client.js';
import { productionPrompt } from '../lib/prompts/runtime.js';
import { readSystemFragmentFile } from '../lib/prompts/run-file.js';
import {
  correctInvalidDigestCategories,
  stableDigestHash,
  strictDigestOutput,
  persistDigestCategory,
  reusableDigestCheckpoint,
  reusableDigestArtifact,
  type DigestCategoryProgress,
  type DigestCategoryWarning,
} from './stage3-digest-recovery.js';
import {
  withFilePrompts,
  runPath,
  inheritRunPrompt,
  writeRunFile,
} from '../lib/prompts/run-file.js';
/**
 * Stage 3 Workflow job：消费 Stage 2 DB snapshot，完成排名与 Event–Digest Consolidation。
 * 该阶段把可复现的输入/诊断写入 runtime；每个独立 Ranking 在自身事务中持久化。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  STAGE3_DIGEST_RANKING_PROMPT_VERSION,
  type Stage3DigestRankingCandidate,
  type Stage3DigestRankingInput,
} from '../prompts/stage3-digest-ranking.js';
import { STAGE3_EVENT_RANKING_PROMPT_VERSION } from '../prompts/stage3-event-ranking.js';
import {
  STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
  type Stage3LongFormRankingInput,
} from '../prompts/stage3-long-form-ranking.js';
import {
  runStage3DigestRankingLlm,
  type Stage3DigestRankingResult,
} from './stage3-digest-ranking-llm.js';
import {
  runStage3EventRankingLlm,
  type Stage3EventRankingResult,
} from './stage3-event-ranking-llm.js';
import {
  runStage3LongFormRankingLlm,
  type Stage3LongFormRankingResult,
} from './stage3-long-form-ranking-llm.js';
import {
  persistStage3Ranks,
  type RankingPersistenceUpdate,
  type Stage3PersistenceResult,
} from './stage3-persistence.js';
import type { Stage2Input, Stage2Output } from './stage2-contract.js';
import {
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  missingLlmTokenUsage,
  type LlmTokenUsage,
} from './llm-token-usage.js';
import type {
  Stage3EventRankedOutput,
  Stage3EventRankingInput,
  Stage3RankingOutput,
  Stage3RankingWarnings,
} from './stage3-contract.js';
import {
  deriveStage3EventRankings,
  normalizeStage3EventRankingOutput,
  normalizeStage3RankingOutput,
  parseAndValidateStage3DigestOrderedIdsOutput,
  rebuildStage3DigestRankingFromOrderedIds,
} from './stage3-contract.js';
import { inferSciencePublication } from './science-publication.js';
import { resolveStageLlmModel } from './llm-client.js';
import type { PublishedAtScope } from '../lib/daily-scope.js';
import { resolveDailyScope } from '../lib/daily-scope.js';
import { DEFAULT_STAGE4_EVENT_LIMIT } from './stage4-config.js';
import { loadEventGroupsForRanking } from './event-group-persistence.js';
import {
  buildEventReviewSnapshotItems,
  persistEventReviewSnapshot,
} from './event-review-persistence.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

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

type Stage3IdMap = {
  events: Record<string, string[]>;
  digest: Record<string, Record<string, string>>;
  long_form: Record<string, string>;
};

type Stage3RankingStatus = 'pending' | 'success' | 'failed' | 'skipped';

type Stage3RankingStatuses = {
  event: Stage3RankingStatus;
  digest: Stage3RankingStatus;
  long_form: Stage3RankingStatus;
};

type Stage3RankingLlmResult =
  Stage3EventRankingResult | Stage3DigestRankingResult | Stage3LongFormRankingResult;

export class Stage3RankingFailureError extends Error {
  constructor(
    label: string,
    readonly result: Extract<Stage3RankingLlmResult, { success: false }>,
  ) {
    super(`${label} failed: ${result.error}`);
    this.name = 'Stage3RankingFailureError';
  }
}

type Stage3ResumeArtifact = {
  runDir: string;
  runId: string;
  eventReviewRunId: string;
  hashes: { event: string; digest?: string; longForm?: string };
  statuses: Stage3RankingStatuses;
};

export type Stage3JobOptions = {
  onRuntimeCreated?: (directory: string) => Promise<void>;
  stage2RunDir?: string;
  stage1RunDir?: string;
  publishedWithinHours?: number;
  publishedAtScope?: PublishedAtScope;
  model?: string;
  rootDir?: string;
  dailyDate?: string;
  pipelineRunId?: string;
  rankers?: {
    events?: typeof rankEvents;
    digest?: typeof rankDigest;
    longForm?: typeof rankLongForm;
    consolidation?: typeof runStage3Consolidation;
  };
};

export type Stage3JobResult = {
  success: boolean;
  status: 'success' | 'partial' | 'failed';
  runDir: string;
  error: string | null;
  eventGroupCount: number;
  eventSelectedCount: number;
  digestInputCount: number;
  digestAfterConsolidation: number;
  digestCategoryCounts: Record<string, number>;
  longFormCount: number;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  tokenUsage: Stage3TokenUsage | null;
  persistence: Stage3PersistenceResult | null;
  eventReviewRunId: string | null;
  warningCount: number;
  duplicateRankingCount: number;
  missingRankingCount: number;
  invalidRankingCount: number;
  deterministicFallbackCount: number;
  inputSnapshotHashes: { event: string; digest: string; longForm: string } | null;
  rankingStatuses: Stage3RankingStatuses;
  digestCategories: Record<string, DigestCategoryProgress>;
  categoryCorrections: DigestCategoryWarning[];
};

export function stage3WarningMetrics(
  result: Pick<
    Stage3JobResult,
    | 'warningCount'
    | 'duplicateRankingCount'
    | 'missingRankingCount'
    | 'invalidRankingCount'
    | 'deterministicFallbackCount'
  >,
) {
  return {
    warning_count: result.warningCount,
    duplicate_ranking_count: result.duplicateRankingCount,
    missing_ranking_count: result.missingRankingCount,
    invalid_ranking_count: result.invalidRankingCount,
    deterministic_fallback_count: result.deterministicFallbackCount,
  };
}

const DEFAULT_LOOKBACK_HOURS = 24;
const CATEGORY_ORDER = [
  'Company',
  'Finance & Economy',
  'General',
  'Policy',
  'Science',
  'Technology',
];

/**
 * 执行 Stage 3，并优先使用 Daily 传入的 Stage 2 run 与其关联的 Stage 1 lineage。
 * 单独运行时仍允许回退到最近成功的 Stage 2 artifact。
 */
export async function processStage3(
  pool: Pool,
  options: Stage3JobOptions = {},
): Promise<Stage3JobResult> {
  const startedAt = new Date();
  const path = runPath('stage3', startedAt, options.rootDir);
  await mkdir(dirname(path), { recursive: true });
  try {
    await options.onRuntimeCreated?.(dirname(path));
  } catch (error) {
    console.error('Failed to observe Runtime directory.', error);
  }
  return withFilePrompts(pool, path, () => processStage3Bound(pool, options, startedAt));
}
async function processStage3Bound(
  pool: Pool,
  options: Stage3JobOptions = {},
  startedAt: Date,
): Promise<Stage3JobResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const runId = toRunTimestamp(startedAt);
  const runDir = join(rootDir, 'runtime/stage3', runId);
  const eventsDir = join(runDir, 'events');
  const digestDir = join(runDir, 'digest');
  const longFormDir = join(runDir, 'long-form');
  const model = resolveStageLlmModel('stage3', options.model);
  const publishedWithinHours = options.publishedWithinHours ?? DEFAULT_LOOKBACK_HOURS;
  const dailyDate = options.dailyDate ?? resolveDailyScope(undefined, startedAt).dailyDate;

  await mkdir(eventsDir, { recursive: true });
  await mkdir(digestDir, { recursive: true });
  await mkdir(longFormDir, { recursive: true });

  let sourceStage2RunDir = '';
  const sourceStage1RunDir = '';
  const stage1StartedAt = '';
  const stage1FinishedAt = '';
  let eventGroupCount = 0;
  let eventSelectedCount = 0;
  let digestInputCount = 0;
  let digestAfterConsolidation = 0;
  let digestCategoryCounts: Record<string, number> = {};
  let longFormCount = 0;
  let llmCallCount = 0;
  let retryCount = 0;
  let llmDurationMs = 0;
  let tokenUsage: Stage3TokenUsage = emptyLlmTokenUsage();
  let persistence: Stage3PersistenceResult | null = null;
  let eventReviewRunId: string | null = null;
  let persistenceStatus: 'not_started' | 'success' | 'failed' = 'not_started';
  let rankingStatuses: Stage3RankingStatuses = {
    event: 'pending',
    digest: 'pending',
    long_form: 'pending',
  };
  let inputSnapshotHashes: Stage3JobResult['inputSnapshotHashes'] = null;
  let error: string | null = null;
  const digestCategories: Record<string, DigestCategoryProgress> = {};
  let categoryCorrections: DigestCategoryWarning[] = [];
  const digestErrors: string[] = [];
  let warningCount = 0;
  let duplicateRankingCount = 0;
  let missingRankingCount = 0;
  let invalidRankingCount = 0;
  let deterministicFallbackCount = 0;
  let activeStep: { section: Stage3Section; category: string | null; state: Stage3Step } | null =
    null;
  const stepState = (
    status: Stage3Step['status'],
    result: {
      calls: number;
      retries: number;
      durationMs: number;
      tokenUsage: Stage3TokenUsage | null;
      warnings?: Stage3RankingWarnings;
    },
  ): Stage3Step => ({
    status,
    model,
    provider: resolveStageLlmProvider('stage3'),
    llm_calls: result.calls,
    retries: result.retries,
    duration_ms: result.durationMs,
    token_usage: result.tokenUsage,
    ...(result.warnings
      ? {
          validation: {
            duplicate_count: result.warnings.duplicateIds.length,
            missing_count: result.warnings.missingIds.length,
            invalid_count: result.warnings.inventedIds.length,
            fallback_count: result.warnings.fallbackIdCount,
          },
        }
      : {}),
  });

  try {
    if (!options.pipelineRunId)
      throw new Error('Stage3 requires a durable pipeline_runs ID before ranking.');
    const activeMemories = await getActiveMemories(pool, { types: ['content', 'event'] });
    const memoryContext = formatMemories(
      activeMemories.filter((memory) => memory.type === 'content'),
    );
    const eventMemoryContext = formatMemories(activeMemories);
    categoryCorrections = await correctInvalidDigestCategories(pool, dailyDate);
    warningCount += categoryCorrections.length;
    if (categoryCorrections.length) {
      await writeJson(join(runDir, 'category-corrections.json'), categoryCorrections);
      for (const warning of categoryCorrections) console.warn('[stage3]', JSON.stringify(warning));
    }
    // Runtime is retained as optional lineage only. DB event_groups is the business input.
    if (options.stage2RunDir) sourceStage2RunDir = options.stage2RunDir;
    const eventBundle = await buildStage3EventRankingInputFromDb(pool, dailyDate);
    eventGroupCount = eventBundle.input.events.length;
    await writeJson(join(eventsDir, 'input.json'), eventBundle.input);

    const digestRows = await loadStage3RankingRows(pool, 'digest', dailyDate);
    const longFormRows = await loadStage3RankingRows(pool, 'long_form', dailyDate);
    const longFormRecords = buildLongFormRecords(longFormRows);
    digestInputCount = digestRows.length;

    const eventHash = snapshotHash(eventBundle.input);
    const databaseEvent = await reusableEventCheckpoint(
      pool,
      dailyDate,
      eventHash,
      eventBundle.input,
      eventBundle.idMap,
    );
    let resume = await findStage3ResumeArtifact(rootDir, dailyDate, eventHash);
    if (databaseEvent && resume?.eventReviewRunId !== databaseEvent.reviewRunId) resume = null;
    if (databaseEvent)
      await restoreStage3Prompt(
        pool,
        join(runDir, 'run.json'),
        'daily.stage3.event_ranking',
        databaseEvent.detail,
      );
    else if (resume)
      await inheritRunPrompt(
        join(runDir, 'run.json'),
        join(resume.runDir, 'run.json'),
        'daily.stage3.event_ranking',
        pool,
      );
    const eventPrompt = eventBundle.input.events.length
      ? await productionPrompt('daily.stage3.event_ranking', JSON.stringify(eventBundle.input))
      : null;
    const eventState: Stage3Step = {
      status: 'running',
      input_hash: eventHash,
      id_map_hash: stage3Hash(eventBundle.idMap),
      prompt_version_id: eventPrompt?.versionId ?? null,
      system_fragment_versions: (await readSystemFragmentFile(join(runDir, 'run.json'))) ?? null,
      candidate_count: eventBundle.input.events.length,
      model,
      provider: resolveStageLlmProvider('stage3'),
    };
    activeStep = { section: 'event_ranking', category: null, state: eventState };
    await writeStage3Step(pool, options.pipelineRunId, 'event_ranking', null, eventState);
    const reusableEvent = databaseEvent
      ? {
          output: databaseEvent.output,
          calls: 0,
          retries: 0,
          durationMs: 0,
          tokenUsage: null,
          diagnostics: { reused: 'database' },
          warnings: emptyRankingWarnings(),
        }
      : resume && canReuseStage3Ranking(eventHash, resume.hashes.event, resume.statuses.event)
        ? await loadReusableEventRanking(pool, resume, eventBundle.input)
        : null;
    const eventRanking =
      reusableEvent ??
      (await (options.rankers?.events ?? rankEvents)(eventBundle.input, {
        model,
        memoryContext: eventMemoryContext,
      }));
    if (reusableEvent) {
      rankingStatuses.event = 'skipped';
      eventReviewRunId = databaseEvent?.reviewRunId ?? resume!.eventReviewRunId;
    } else {
      ({
        warningCount,
        duplicateRankingCount,
        missingRankingCount,
        invalidRankingCount,
        deterministicFallbackCount,
      } = addRankingWarnings(
        {
          warningCount,
          duplicateRankingCount,
          missingRankingCount,
          invalidRankingCount,
          deterministicFallbackCount,
        },
        eventRanking.warnings,
      ));
      llmCallCount += eventRanking.calls;
      retryCount += eventRanking.retries;
      llmDurationMs += eventRanking.durationMs;
      tokenUsage = addStage3TokenUsage(tokenUsage, eventRanking.tokenUsage);
    }
    await writeJson(join(eventsDir, 'ranking-output.json'), eventRanking.output);
    await writeJson(join(eventsDir, 'ranking-diagnostics.json'), eventRanking.diagnostics);

    if (!reusableEvent) eventReviewRunId = randomUUID();
    const committedEventState: Stage3Step = {
      ...eventState,
      ...stepState(reusableEvent ? 'skipped' : 'success', eventRanking),
      review_run_id: eventReviewRunId,
      ordered_ids: eventRanking.output.rankings.map((r) => r.id),
      ...(databaseEvent ? { source_run_id: databaseEvent.id } : {}),
    };
    const snapshotItems = buildEventReviewSnapshotItems({
      reviewRunId: eventReviewRunId!,
      dailyDate,
      rankingOutput: eventRanking.output,
      eventInput: eventBundle.input,
      eventIdMap: eventBundle.idMap,
    });
    if (!reusableEvent && snapshotItems.length) {
      persistenceStatus = 'failed';
      await persistEventReviewSnapshot(pool, snapshotItems, (client) =>
        writeStage3Step(client, options.pipelineRunId!, 'event_ranking', null, committedEventState),
      );
      persistenceStatus = 'success';
    } else
      await writeStage3Step(
        pool,
        options.pipelineRunId,
        'event_ranking',
        null,
        committedEventState,
      );
    rankingStatuses.event = reusableEvent ? 'skipped' : 'success';
    activeStep = null;

    const selectedEvents = selectTopEvents({
      rankingOutput: eventRanking.output,
      eventInput: eventBundle.input,
      eventIdMap: eventBundle.idMap,
      topN: DEFAULT_STAGE4_EVENT_LIMIT,
    });
    eventSelectedCount = selectedEvents.events.length;
    await writeJson(join(eventsDir, 'selected.json'), selectedEvents);

    const consolidationErrors: string[] = [];
    for (const category of CATEGORY_ORDER) {
      activeStep = {
        section: 'consolidation',
        category,
        state: { status: 'running', model, provider: resolveStageLlmProvider('stage3') },
      };
      const result = await consolidateDigestCategory(pool, {
        runId: options.pipelineRunId,
        dailyDate,
        reviewRunId: eventReviewRunId!,
        path: join(runDir, 'run.json'),
        model,
        input: {
          category,
          events: selectedEvents.events.map((e) => ({ event_group_id: e.id, hint: e.event_hint })),
          candidates: digestRows
            .filter((r) => r.category === category)
            .map((r) => ({
              id: r.processedContentId,
              title: r.title,
              summary: r.summary ?? '',
              source: r.source,
            })),
        },
        invoke: options.rankers?.consolidation,
      });
      llmCallCount += result.metrics.calls;
      retryCount += result.metrics.retries;
      llmDurationMs += result.metrics.durationMs;
      tokenUsage = addStage3TokenUsage(tokenUsage, result.metrics.tokenUsage);
      if (!result.success) consolidationErrors.push(`${category}: ${result.error}`);
      activeStep = null;
    }
    const remainingDigestRows = await loadStage3RankingRows(pool, 'digest', dailyDate);
    const digestRecords = buildDigestRecords(remainingDigestRows);
    digestAfterConsolidation = digestRecords.length;
    digestCategoryCounts = countByCategory(digestRecords);
    longFormCount = longFormRecords.length;
    const digestInputs = buildDigestInputs(digestRecords);
    const longFormInput = buildLongFormInput(longFormRecords);
    inputSnapshotHashes = {
      event: eventHash,
      digest: snapshotHash(digestInputs),
      longForm: snapshotHash(longFormInput),
    };
    const idMap: Stage3IdMap = {
      events: selectedEvents.idMap,
      digest: buildDigestIdMap(digestRecords),
      long_form: buildLongFormIdMap(longFormRecords),
    };

    await writeJson(join(runDir, 'id-map.json'), idMap);
    for (const input of Object.values(digestInputs)) {
      if (input.candidates.length === 0) {
        continue;
      }

      await writeJson(join(digestDir, `${toSlug(input.category)}-input.json`), input);
    }
    await writeJson(join(longFormDir, 'input.json'), longFormInput);

    // Save the recovery identity before any category can commit. A crash after a database
    // commit must still leave a discoverable Run carrying the pre-call Prompt binding.
    await writeJson(join(runDir, 'run.json'), {
      run_id: runId,
      daily_date: dailyDate,
      event_review_run_id: eventReviewRunId,
      input_snapshot_hashes: {
        event: eventHash,
        digest: inputSnapshotHashes.digest,
        long_form: inputSnapshotHashes.longForm,
      },
      ranking_statuses: rankingStatuses,
      digest_categories: digestCategories,
      category_corrections: categoryCorrections,
    });

    let restoredDigest = false;
    for (const category of Object.keys(digestInputs)) {
      const hash = stableDigestHash(digestInputs[category], idMap.digest[category] ?? {});
      const previous = (await stage3Checkpoints(pool, dailyDate, 'digest_ranking', category)).find(
        (r) => r.detail.input_hash === hash && typeof r.detail.prompt_version_id === 'string',
      );
      if (previous) {
        await restoreStage3Prompt(
          pool,
          join(runDir, 'run.json'),
          'daily.stage3.digest_ranking',
          previous.detail,
        );
        restoredDigest = true;
        break;
      }
    }
    // Fix one Request version for every category, including categories whose inputs changed.
    // A matching prior category is sufficient evidence to retain that Run's Digest binding.
    if (
      !restoredDigest &&
      resume &&
      (resume.hashes.digest === inputSnapshotHashes.digest ||
        (await hasMatchingDigestCategory(resume.runDir, digestInputs, idMap.digest)))
    )
      await inheritRunPrompt(
        join(runDir, 'run.json'),
        join(resume.runDir, 'run.json'),
        'daily.stage3.digest_ranking',
        pool,
      );
    const digestRankings: Record<string, Stage3RankingOutput> = {};
    const snapshot = await readSystemFragmentFile(join(runDir, 'run.json'));
    const digestCategoriesToProcess = CATEGORY_ORDER;
    for (const category of digestCategoriesToProcess) {
      const input = digestInputs[category] ?? { category, candidates: [] };
      const inputHash = stableDigestHash(input, idMap.digest[category] ?? {});
      const progress: DigestCategoryProgress = {
        category,
        input_hash: inputHash,
        status: 'failed',
        reused: null,
        llm_calls: 0,
        input_tokens: null,
        output_tokens: null,
        warning_count: 0,
        error: null,
        model,
        provider: resolveStageLlmProvider('stage3'),
        retries: 0,
        duration_ms: 0,
      };
      digestCategories[category] = progress;
      activeStep = {
        section: 'digest_ranking',
        category,
        state: {
          ...progress,
          status: 'running',
          model,
          provider: resolveStageLlmProvider('stage3'),
        },
      };
      await writeStage3Step(
        pool,
        options.pipelineRunId,
        'digest_ranking',
        category,
        activeStep.state,
      );
      if (!input.candidates.length) {
        // No Digest members remain in this category. Clear only this category's stale ranks, with no Prompt or LLM.
        persistenceStatus = 'failed';
        const committed = await persistDigestCategory(
          pool,
          options.pipelineRunId,
          dailyDate,
          {
            status: 'success',
            category,
            input_hash: inputHash,
            prompt_version_id: null,
            system_fragment_versions: snapshot ?? null,
            ranked_ids: [],
            execution: { ...progress, status: 'skipped' },
          },
          {
            ranked: [],
            staleProcessedContentIds: digestRecords
              .filter((r) => r.category === category)
              .map((r) => r.processedContentId),
          },
        );
        persistence = combineStage3Persistence(persistence, committed);
        persistenceStatus = 'success';
        progress.status = 'skipped';
        activeStep = null;
        await writeJson(join(digestDir, `${toSlug(category)}-status.json`), progress);
        continue;
      }
      // Registry loading errors are fatal configuration failures, not per-category model failures.
      const prompt = await productionPrompt('daily.stage3.digest_ranking', JSON.stringify(input), {
        category,
      });
      activeStep.state = {
        ...activeStep.state,
        prompt_version_id: prompt.versionId,
        system_fragment_versions: snapshot ?? null,
      };
      await writeStage3Step(
        pool,
        options.pipelineRunId,
        'digest_ranking',
        category,
        activeStep.state,
      );
      const beforeLookup: 'not_started' | 'success' | 'failed' = persistenceStatus;
      persistenceStatus = 'failed';
      const reused = await reusableDigestCheckpoint(
        pool,
        dailyDate,
        input,
        idMap.digest[category],
        inputHash,
        prompt.versionId,
        snapshot,
      );
      persistenceStatus = beforeLookup;
      const artifact = reused
        ? null
        : await reusableDigestArtifact(
            rootDir,
            runDir,
            dailyDate,
            input,
            idMap.digest[category],
            inputHash,
            prompt.versionId,
            snapshot,
          );
      let output: Stage3RankingOutput;
      try {
        if (reused || artifact) {
          output = (reused ?? artifact)!;
          progress.reused = reused ? 'database' : 'artifact';
          progress.input_tokens = 0;
          progress.output_tokens = 0;
          if (artifact) progress.source_run_id = artifact.source_run_id;
          else if (reused?.source_run_id) progress.source_run_id = reused.source_run_id;
        } else {
          const result = await (options.rankers?.digest ?? rankDigest)(input, {
            model,
            memoryContext,
          });
          ({
            warningCount,
            duplicateRankingCount,
            missingRankingCount,
            invalidRankingCount,
            deterministicFallbackCount,
          } = addRankingWarnings(
            {
              warningCount,
              duplicateRankingCount,
              missingRankingCount,
              invalidRankingCount,
              deterministicFallbackCount,
            },
            result.warnings,
          ));
          llmCallCount += result.calls;
          retryCount += result.retries;
          llmDurationMs += result.durationMs;
          tokenUsage = addStage3TokenUsage(tokenUsage, result.tokenUsage);
          progress.llm_calls = result.calls;
          progress.retries = result.retries;
          progress.duration_ms = result.durationMs;
          progress.token_usage = result.tokenUsage;
          progress.input_tokens = result.tokenUsage?.inputTokens ?? null;
          progress.output_tokens = result.tokenUsage?.outputTokens ?? null;
          progress.warning_count =
            result.warnings.duplicateIds.length +
            result.warnings.missingIds.length +
            result.warnings.inventedIds.length +
            result.warnings.rankNormalizationCount;
          output = result.output;
          await writeJson(join(digestDir, `${toSlug(category)}-ranking-diagnostics.json`), {
            ...result.diagnostics,
            input_hash: inputHash,
          });
        }
      } catch (caught) {
        if (caught instanceof Stage3RankingFailureError) {
          const metrics = stage3RankingFailureMetrics(caught.result);
          llmCallCount += metrics.calls;
          retryCount += metrics.retries;
          llmDurationMs += metrics.durationMs;
          tokenUsage = addStage3TokenUsage(tokenUsage, metrics.tokenUsage);
          const warnings = rankingFailureWarnings(caught.result);
          ({
            warningCount,
            duplicateRankingCount,
            missingRankingCount,
            invalidRankingCount,
            deterministicFallbackCount,
          } = addRankingWarnings(
            {
              warningCount,
              duplicateRankingCount,
              missingRankingCount,
              invalidRankingCount,
              deterministicFallbackCount,
            },
            warnings,
          ));
          progress.llm_calls = metrics.calls;
          progress.retries = metrics.retries;
          progress.duration_ms = metrics.durationMs;
          progress.token_usage = metrics.tokenUsage;
          progress.input_tokens = metrics.tokenUsage?.inputTokens ?? null;
          progress.output_tokens = metrics.tokenUsage?.outputTokens ?? null;
          progress.warning_count =
            warnings.duplicateIds.length +
            warnings.missingIds.length +
            warnings.inventedIds.length +
            warnings.rankNormalizationCount;
          await writeJson(
            join(digestDir, `${toSlug(category)}-ranking-failure-diagnostics.json`),
            rankingFailureDiagnostics(caught.result),
          );
        }
        progress.error = caught instanceof Error ? caught.message : String(caught);
        digestErrors.push(`${category}: ${progress.error}`);
        await writeStage3Step(pool, options.pipelineRunId, 'digest_ranking', category, {
          ...activeStep!.state,
          ...progress,
          status: 'failed',
        });
        activeStep = null;
        await writeJson(join(digestDir, `${toSlug(category)}-status.json`), progress);
        continue;
      }
      const validated = strictDigestOutput(output, input);
      if (!validated) throw new Error(`Digest ${category} did not produce a complete ranking.`);
      output = validated;
      await writeJson(join(digestDir, `${toSlug(category)}-ranking-output.json`), output);
      digestRankings[category] = output;
      if (progress.reused)
        await writeJson(join(digestDir, `${toSlug(category)}-ranking-diagnostics.json`), {
          category,
          input_count: input.candidates.length,
          input_hash: inputHash,
          normalized_output_count: output.rankings.length,
          reused: progress.reused,
        });
      {
        // Reapply only this category, including stale members, even when the ranking is reused.
        persistenceStatus = 'failed';
        const committed = await persistDigestCategory(
          pool,
          options.pipelineRunId,
          dailyDate,
          {
            status: 'success',
            category,
            input_hash: inputHash,
            prompt_version_id: prompt.versionId,
            system_fragment_versions: snapshot ?? null,
            ranked_ids: output.rankings.map((r) => idMap.digest[category][r.id]),
            execution: { ...progress, status: progress.reused ? 'skipped' : 'success' },
          },
          buildPersistencePlan({
            allDigestRecords: digestRecords.filter((r) => r.category === category),
            allLongFormRecords: [],
            finalDigestIdMap: idMap.digest,
            finalLongFormIdMap: {},
            digestRankings: { [category]: output },
            longFormRanking: { rankings: [] },
          }),
        );
        persistence = combineStage3Persistence(persistence, committed);
        persistenceStatus = 'success';
      }
      progress.status = progress.reused ? 'skipped' : 'success';
      activeStep = null;
      await writeJson(join(digestDir, `${toSlug(category)}-status.json`), progress);
      // Helpful on crash, but the database checkpoint is the authoritative committed marker.
      await writeJson(join(runDir, 'run.json'), {
        run_id: runId,
        daily_date: dailyDate,
        event_review_run_id: eventReviewRunId,
        input_snapshot_hashes: {
          event: eventHash,
          digest: inputSnapshotHashes.digest,
          long_form: inputSnapshotHashes.longForm,
        },
        ranking_statuses: rankingStatuses,
        digest_categories: digestCategories,
        category_corrections: categoryCorrections,
      });
    }
    rankingStatuses.digest = digestErrors.length
      ? 'failed'
      : Object.values(digestCategories).every((c) => c.reused)
        ? 'skipped'
        : 'success';

    const databaseLongForm = await reusableLongFormCheckpoint(
      pool,
      dailyDate,
      inputSnapshotHashes.longForm,
      idMap.long_form,
    );
    if (databaseLongForm)
      await restoreStage3Prompt(
        pool,
        join(runDir, 'run.json'),
        'daily.stage3.long_form_ranking',
        databaseLongForm.detail,
      );
    if (!databaseLongForm && resume && resume.hashes.longForm === inputSnapshotHashes.longForm)
      await inheritRunPrompt(
        join(runDir, 'run.json'),
        join(resume.runDir, 'run.json'),
        'daily.stage3.long_form_ranking',
        pool,
      );
    const reusableLongForm = databaseLongForm
      ? {
          output: databaseLongForm.output,
          calls: 0,
          retries: 0,
          durationMs: 0,
          tokenUsage: null,
          warnings: emptyRankingWarnings(),
        }
      : resume &&
          canReuseStage3Ranking(
            inputSnapshotHashes.longForm,
            resume.hashes.longForm,
            resume.statuses.long_form,
          )
        ? await loadReusableLongFormRanking(resume, longFormInput)
        : null;
    const longPrompt = longFormInput.candidates.length
      ? await productionPrompt('daily.stage3.long_form_ranking', JSON.stringify(longFormInput))
      : null;
    const longState: Stage3Step = {
      status: 'running',
      input_hash: inputSnapshotHashes.longForm,
      id_map_hash: stage3Hash(idMap.long_form),
      prompt_version_id: longPrompt?.versionId ?? null,
      system_fragment_versions: (await readSystemFragmentFile(join(runDir, 'run.json'))) ?? null,
      candidate_count: longFormInput.candidates.length,
    };
    activeStep = { section: 'long_form_ranking', category: null, state: longState };
    await writeStage3Step(pool, options.pipelineRunId, 'long_form_ranking', null, longState);
    const longFormRanking =
      reusableLongForm ??
      (await (options.rankers?.longForm ?? rankLongForm)(longFormInput, { model, memoryContext }));
    if (reusableLongForm) {
      rankingStatuses.long_form = 'skipped';
    } else {
      ({
        warningCount,
        duplicateRankingCount,
        missingRankingCount,
        invalidRankingCount,
        deterministicFallbackCount,
      } = addRankingWarnings(
        {
          warningCount,
          duplicateRankingCount,
          missingRankingCount,
          invalidRankingCount,
          deterministicFallbackCount,
        },
        longFormRanking.warnings,
      ));
      llmCallCount += longFormRanking.calls;
      retryCount += longFormRanking.retries;
      llmDurationMs += longFormRanking.durationMs;
      tokenUsage = addStage3TokenUsage(tokenUsage, longFormRanking.tokenUsage);
    }
    await writeJson(join(longFormDir, 'ranking-output.json'), longFormRanking.output);
    await writeJson(join(longFormDir, 'ranking-diagnostics.json'), {
      input_count: longFormInput.candidates.length,
      model_valid_id_count: longFormRanking.warnings.modelValidIdCount,
      duplicate_ids: longFormRanking.warnings.duplicateIds,
      invalid_ids: longFormRanking.warnings.inventedIds,
      missing_ids: longFormRanking.warnings.missingIds,
      fallback_id_count: longFormRanking.warnings.fallbackIdCount,
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
    await writeJson(join(runDir, 'persistence-plan.json'), persistencePlan);

    if (!reusableLongForm) {
      persistenceStatus = 'failed';
      const longFormPersistence = await persistStage3Plan(pool, persistencePlan, (client) =>
        writeStage3Step(client, options.pipelineRunId!, 'long_form_ranking', null, {
          ...longState,
          ...stepState('success', longFormRanking),
          ranked_ids: longFormRanking.output.rankings.map((r) => idMap.long_form[r.id]),
        }),
      );
      persistenceStatus = 'success';
      persistence = combineStage3Persistence(persistence, longFormPersistence);
      rankingStatuses.long_form = 'success';
    }

    if (reusableLongForm)
      await writeStage3Step(pool, options.pipelineRunId, 'long_form_ranking', null, {
        ...longState,
        ...stepState('skipped', longFormRanking),
        ranked_ids: longFormRanking.output.rankings.map((r) => idMap.long_form[r.id]),
        source_run_id: databaseLongForm?.id ?? null,
      });
    activeStep = null;
    if (digestErrors.length || consolidationErrors.length)
      throw new Error(
        [...consolidationErrors.map((e) => `Consolidation ${e}`), ...digestErrors].join('; '),
      );

    await writeRunJson(join(runDir, 'run.json'), {
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
      status: 'success',
      publishedWithinHours,
      eventGroupCount,
      eventSelectedCount,
      digestInputCount,
      digestAfterConsolidation,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      tokenUsage: llmCallCount > 0 ? tokenUsage : null,
      persistenceStatus,
      persistence,
      error: null,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      invalidRankingCount,
      deterministicFallbackCount,
      inputSnapshotHashes,
      rankingStatuses,
      digestCategories,
      categoryCorrections,
    });

    return {
      success: true,
      status: 'success',
      runDir,
      error: null,
      eventGroupCount,
      eventSelectedCount,
      digestInputCount,
      digestAfterConsolidation,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      tokenUsage: llmCallCount > 0 ? tokenUsage : null,
      persistence,
      eventReviewRunId,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      invalidRankingCount,
      deterministicFallbackCount,
      inputSnapshotHashes,
      rankingStatuses,
      digestCategories,
      categoryCorrections,
    };
  } catch (caught) {
    error = stage3Error(caught);
    if (activeStep?.section === 'consolidation') persistenceStatus = 'failed';
    if (caught instanceof ConsolidationPersistenceError) {
      persistenceStatus = 'failed';
      llmCallCount += caught.metrics.calls;
      retryCount += caught.metrics.retries;
      llmDurationMs += caught.metrics.durationMs;
      tokenUsage = addStage3TokenUsage(tokenUsage, caught.metrics.tokenUsage);
      if (activeStep) activeStep.state = caught.step;
    }
    if (activeStep) {
      const failed =
        caught instanceof Stage3RankingFailureError
          ? stage3RankingFailureMetrics(caught.result)
          : null;
      try {
        await writeStage3Step(
          pool,
          options.pipelineRunId!,
          activeStep.section,
          activeStep.category,
          {
            ...activeStep.state,
            ...(failed ? stepState('failed', failed) : {}),
            status: 'failed',
            error,
          },
        );
      } catch (diagnosticError) {
        persistenceStatus = 'failed';
        console.error('Stage3 failure details could not be saved', diagnosticError);
      }
    }
    const interruptedCategory = Object.values(digestCategories).find(
      (item) => item.status === 'failed' && item.error === null,
    );
    if (interruptedCategory) {
      interruptedCategory.error = error;
      await writeJson(
        join(digestDir, `${toSlug(interruptedCategory.category)}-status.json`),
        interruptedCategory,
      );
    }
    if (caught instanceof Stage3RankingFailureError) {
      const failureMetrics = stage3RankingFailureMetrics(caught.result);
      llmCallCount += failureMetrics.calls;
      retryCount += failureMetrics.retries;
      llmDurationMs += failureMetrics.durationMs;
      tokenUsage = addStage3TokenUsage(tokenUsage, failureMetrics.tokenUsage);
      ({
        warningCount,
        duplicateRankingCount,
        missingRankingCount,
        invalidRankingCount,
        deterministicFallbackCount,
      } = addRankingWarnings(
        {
          warningCount,
          duplicateRankingCount,
          missingRankingCount,
          invalidRankingCount,
          deterministicFallbackCount,
        },
        rankingFailureWarnings(caught.result),
      ));
      await writeJson(
        join(runDir, 'ranking-failure-diagnostics.json'),
        rankingFailureDiagnostics(caught.result),
      );
    }
    const failedRanking = Object.entries(rankingStatuses).find(
      ([, status]) => status === 'pending',
    )?.[0] as keyof Stage3RankingStatuses | undefined;
    if (failedRanking) rankingStatuses = { ...rankingStatuses, [failedRanking]: 'failed' };
    // A persistence error is never represented as partial: it is not safe to
    // treat an incomplete database write as a usable product.
    const status =
      persistenceStatus === 'failed'
        ? 'failed'
        : Object.values(rankingStatuses).some(isUsableRankingStatus)
          ? 'partial'
          : 'failed';
    await writeRunJson(join(runDir, 'run.json'), {
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
      digestInputCount,
      digestAfterConsolidation,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      tokenUsage: llmCallCount > 0 ? tokenUsage : null,
      persistenceStatus,
      persistence,
      error,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      invalidRankingCount,
      deterministicFallbackCount,
      inputSnapshotHashes,
      rankingStatuses,
      digestCategories,
      categoryCorrections,
    });

    return {
      success: false,
      status,
      runDir,
      error,
      eventGroupCount,
      eventSelectedCount,
      digestInputCount,
      digestAfterConsolidation,
      digestCategoryCounts,
      longFormCount,
      llmCallCount,
      retryCount,
      llmDurationMs,
      tokenUsage: llmCallCount > 0 ? tokenUsage : null,
      persistence,
      eventReviewRunId,
      warningCount,
      duplicateRankingCount,
      missingRankingCount,
      invalidRankingCount,
      deterministicFallbackCount,
      inputSnapshotHashes,
      rankingStatuses,
      digestCategories,
      categoryCorrections,
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
  const run = await readJson<Stage2RunArtifact>(join(runDir, 'run.json'));
  if (!stage2RunDirOption && run.status !== 'success') {
    throw new Error(`Stage 2 runtime directory is not successful: ${runDir}`);
  }

  const input = await readJson<Stage2Input>(join(runDir, 'input.json'));
  const output = await readJson<Stage2Output>(join(runDir, 'output.json'));
  const idMap = await readJson<Stage2IdMap>(join(runDir, 'id-map.json'));
  // Temporary diagnostic mode: Stage 2 output and assignment validation are
  // intentionally bypassed so incomplete/duplicate groups can feed Stage 3.
  validateStage2IdMap(input, idMap);

  await stat(join(runDir, 'output.json'));
  return {
    runDir,
    run,
    input,
    output,
    idMap,
  };
}

async function findLatestSuccessfulStage2RunDir(rootDir: string): Promise<string> {
  const root = join(rootDir, 'runtime/stage2');
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    try {
      const run = await readJson<Stage2RunArtifact>(join(candidate, 'run.json'));
      await stat(join(candidate, 'input.json'));
      await stat(join(candidate, 'id-map.json'));
      await stat(join(candidate, 'output.json'));
      if (run.status === 'success') {
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
  const groups = new Map<
    string,
    {
      event_hint: string;
      sources: Array<{ source: string; title: string; summary: string }>;
      members: string[];
    }
  >();
  for (const row of rows) {
    const group = groups.get(row.eventGroupId) ?? {
      event_hint: row.eventHint,
      sources: [],
      members: [],
    };
    group.sources.push({ source: row.source, title: row.title, summary: row.summary ?? '' });
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
    throw new Error('Stage 2 id-map contains duplicate processed_content_id mappings.');
  }
}

/** 读取本次 Stage 1 新产生的 Digest / Long-form 候选。 */
export async function loadStage3RankingRows(
  queryable: Queryable,
  routing: 'digest' | 'long_form',
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
        summary: row.summary ?? '',
        source: row.source,
        publication:
          row.category === 'Science'
            ? inferSciencePublication({ url: row.url, sourceName: row.source }).publication
            : undefined,
      },
      processedContentId: row.processedContentId,
      sourcePriority: row.sourcePriority,
      url: row.url,
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
      summary: row.summary ?? '',
      source: row.source,
    },
    processedContentId: row.processedContentId,
    sourcePriority: row.sourcePriority,
    url: row.url,
    originalIndex: index,
  }));
}

async function rankEvents(
  input: Stage3EventRankingInput,
  options: { model: string; memoryContext?: string },
): Promise<{
  output: Stage3EventRankedOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: Stage3TokenUsage | null;
  diagnostics: {
    input_event_count: number;
    returned_ranking_count: number;
    model_valid_id_count: number;
    duplicate_ids: string[];
    invalid_ids: string[];
    fallback_ids: string[];
  };
  warnings: Stage3RankingWarnings;
}> {
  if (input.events.length === 0) {
    return {
      output: { rankings: [] },
      calls: 0,
      retries: 0,
      durationMs: 0,
      tokenUsage: null,
      diagnostics: {
        input_event_count: 0,
        returned_ranking_count: 0,
        model_valid_id_count: 0,
        duplicate_ids: [],
        invalid_ids: [],
        fallback_ids: [],
      },
      warnings: emptyRankingWarnings(),
    };
  }

  const result = await runStage3EventRankingLlm(input, options);
  assertRankingSuccess('Event Ranking', result);
  return {
    output: result.rankings,
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
    diagnostics: {
      input_event_count: input.events.length,
      returned_ranking_count: result.rankings.rankings.length,
      model_valid_id_count: result.warnings.modelValidIdCount,
      duplicate_ids: result.assignment.duplicateIds,
      invalid_ids: result.assignment.inventedIds,
      fallback_ids: result.warnings.missingIds,
    },
    warnings: result.warnings,
  };
}

async function rankDigest(
  input: Stage3DigestRankingInput,
  options: { model: string; memoryContext?: string },
): Promise<{
  output: Stage3RankingOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: Stage3TokenUsage | null;
  diagnostics: {
    category: string;
    input_count: number;
    returned_count: number;
    missing_count: number;
    model_valid_id_count: number;
    fallback_id_count: number;
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
  warnings: Stage3RankingWarnings;
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
      throw new Error(
        `Digest Ranking (${input.category}) failed without a recoverable ranking output.`,
      );
    }
    const initialDiag = result.diagnostics.initial;
    const repairDiag = result.diagnostics.repair;
    return {
      output: recovered.output,
      calls: result.attempts,
      retries: Math.max(0, result.attempts - 1),
      durationMs: result.elapsedMs,
      tokenUsage: sumKnownStage3TokenUsages([
        toStage3TokenUsage(
          initialDiag.input_tokens,
          initialDiag.output_tokens,
          initialDiag.total_tokens,
          initialDiag.cached_input_tokens,
        ),
        repairDiag
          ? toStage3TokenUsage(
              repairDiag.input_tokens,
              repairDiag.output_tokens,
              repairDiag.total_tokens,
            )
          : emptyLlmTokenUsage(),
      ]),
      diagnostics: {
        category: input.category,
        input_count: input.candidates.length,
        returned_count: initialDiag.returned_count ?? 0,
        missing_count: initialDiag.missing_count ?? 0,
        model_valid_id_count: recovered.warnings.modelValidIdCount,
        fallback_id_count: recovered.warnings.fallbackIdCount,
        duplicate_ids: result.assignment?.duplicateIds ?? [],
        invalid_ids: result.assignment?.inventedIds ?? [],
        repair_attempted: result.repair?.attempted ?? false,
        repair_success: result.repair?.success ?? null,
        repaired_count: recovered.output.rankings.length,
        repair_missing_ids: [],
        repair_duplicate_ids: [],
        repair_invalid_ids: [],
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
      toStage3TokenUsage(
        initialDiag.input_tokens,
        initialDiag.output_tokens,
        initialDiag.total_tokens,
        initialDiag.cached_input_tokens,
      ),
      repairDiag
        ? toStage3TokenUsage(
            repairDiag.input_tokens,
            repairDiag.output_tokens,
            repairDiag.total_tokens,
          )
        : emptyLlmTokenUsage(),
    ]),
    diagnostics: {
      category: input.category,
      input_count: input.candidates.length,
      returned_count: result.repair.beforeReturnedCount,
      missing_count: result.repair.before.missingIds.length,
      model_valid_id_count: result.warnings.modelValidIdCount,
      fallback_id_count: result.warnings.fallbackIdCount,
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
    warnings: result.warnings,
  };
}

async function rankLongForm(
  input: Stage3LongFormRankingInput,
  options: { model: string; memoryContext?: string },
): Promise<{
  output: Stage3RankingOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: Stage3TokenUsage | null;
  warnings: Stage3RankingWarnings;
}> {
  if (input.candidates.length === 0) {
    return {
      output: { rankings: [] },
      calls: 0,
      retries: 0,
      durationMs: 0,
      tokenUsage: null,
      warnings: emptyRankingWarnings(),
    };
  }

  const result = await runStage3LongFormRankingLlm(input, options);
  assertRankingSuccess('Long-form Ranking', result);
  return { ...rankingMetrics(result), warnings: result.warnings };
}

function addRankingWarnings(
  current: {
    warningCount: number;
    duplicateRankingCount: number;
    missingRankingCount: number;
    invalidRankingCount: number;
    deterministicFallbackCount: number;
  },
  warnings: Stage3RankingWarnings,
) {
  return {
    warningCount:
      current.warningCount +
      warnings.duplicateIds.length +
      warnings.missingIds.length +
      warnings.inventedIds.length +
      warnings.rankNormalizationCount,
    duplicateRankingCount: current.duplicateRankingCount + warnings.duplicateIds.length,
    missingRankingCount: current.missingRankingCount + warnings.missingIds.length,
    invalidRankingCount: current.invalidRankingCount + warnings.inventedIds.length,
    deterministicFallbackCount: current.deterministicFallbackCount + warnings.fallbackIdCount,
  };
}

function emptyRankingWarnings(): Stage3RankingWarnings {
  return {
    duplicateIds: [],
    missingIds: [],
    inventedIds: [],
    modelValidIdCount: 0,
    fallbackIdCount: 0,
    rankNormalizationCount: 0,
  };
}

function assertRankingSuccess(
  label: string,
  result: Stage3EventRankingResult | Stage3DigestRankingResult | Stage3LongFormRankingResult,
): asserts result is Extract<typeof result, { success: true }> {
  if (!result.success) {
    throw new Stage3RankingFailureError(label, result);
  }
}

function rankingMetrics(result: {
  success: true;
  output: Stage3RankingOutput;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage3TokenUsage | null;
}): {
  output: Stage3RankingOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: Stage3TokenUsage | null;
} {
  return {
    output: result.output,
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
  };
}

type Stage3TokenUsage = LlmTokenUsage;

export function stage3RankingFailureMetrics(
  result: Extract<Stage3RankingLlmResult, { success: false }>,
): { calls: number; retries: number; durationMs: number; tokenUsage: Stage3TokenUsage | null } {
  const tokenUsage =
    'diagnostics' in result
      ? sumKnownStage3TokenUsages([
          toStage3TokenUsage(
            result.diagnostics.initial.input_tokens,
            result.diagnostics.initial.output_tokens,
            result.diagnostics.initial.total_tokens,
          ),
          result.diagnostics.repair
            ? toStage3TokenUsage(
                result.diagnostics.repair.input_tokens,
                result.diagnostics.repair.output_tokens,
                result.diagnostics.repair.total_tokens,
              )
            : emptyLlmTokenUsage(),
        ])
      : result.tokenUsage;
  return {
    calls: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    durationMs: result.elapsedMs,
    tokenUsage,
  };
}

function rankingFailureWarnings(
  result: Extract<Stage3RankingLlmResult, { success: false }>,
): Stage3RankingWarnings {
  const assignment = result.assignment;
  const expectedCount =
    'events' in result.input ? result.input.events.length : result.input.candidates.length;
  return {
    duplicateIds: assignment?.duplicateIds ?? [],
    missingIds: assignment?.missingIds ?? [],
    inventedIds: assignment?.inventedIds ?? [],
    modelValidIdCount: assignment ? expectedCount - assignment.missingIds.length : 0,
    fallbackIdCount: 0,
    rankNormalizationCount: 0,
  };
}

function rankingFailureDiagnostics(result: Extract<Stage3RankingLlmResult, { success: false }>) {
  const warnings = rankingFailureWarnings(result);
  return {
    ranking: 'events' in result.input ? 'event' : 'diagnostics' in result ? 'digest' : 'long_form',
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    llm_duration_ms: result.elapsedMs,
    model_valid_id_count: warnings.modelValidIdCount,
    duplicate_ids: warnings.duplicateIds,
    invalid_ids: warnings.inventedIds,
    missing_ids: warnings.missingIds,
    fallback_id_count: 0,
    error: result.error,
  };
}

function addStage3TokenUsage(
  current: Stage3TokenUsage,
  next: Stage3TokenUsage | null,
): Stage3TokenUsage {
  return mergeLlmTokenUsage(current, next ?? missingLlmTokenUsage());
}

function toStage3TokenUsage(
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
  cachedInputTokens: number | null = null,
): Stage3TokenUsage | null {
  return inputTokens === null || outputTokens === null || totalTokens === null
    ? null
    : {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
        usageComplete: cachedInputTokens !== null,
      };
}

function sumKnownStage3TokenUsages(
  values: Array<Stage3TokenUsage | null>,
): Stage3TokenUsage | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Stage3TokenUsage>(
    (sum, value) => mergeLlmTokenUsage(sum, value!),
    emptyLlmTokenUsage(),
  );
}

export function selectTopEvents(options: {
  rankingOutput: Stage3EventRankedOutput;
  eventInput: Stage3EventRankingInput;
  eventIdMap: Record<string, string[]>;
  topN: number;
}): {
  events: Array<
    Stage3EventRankingInput['events'][number] & {
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

function buildDigestInputs(records: DigestRecord[]): Record<string, Stage3DigestRankingInput> {
  const inputs: Record<string, Stage3DigestRankingInput> = {};
  const categories = [...new Set(records.map((record) => record.category))].sort(
    compareCategoryNames,
  );

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

async function persistStage3Plan(
  pool: Pool,
  plan: ReturnType<typeof buildPersistencePlan>,
  onPersisted?: (client: PoolClient) => Promise<void>,
): Promise<Stage3PersistenceResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await persistStage3Ranks(client, plan);
    if (
      result.rankedUpdated !== plan.ranked.length ||
      result.staleCleared !== plan.staleProcessedContentIds.length
    )
      throw new Error('Stage3 ranking rows changed during persistence.');
    await onPersisted?.(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
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

  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
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
    status: 'success' | 'partial' | 'failed';
    publishedWithinHours: number;
    eventGroupCount: number;
    eventSelectedCount: number;
    digestInputCount: number;
    digestAfterConsolidation: number;
    digestCategoryCounts: Record<string, number>;
    longFormCount: number;
    llmCallCount: number;
    retryCount: number;
    llmDurationMs: number;
    tokenUsage: Stage3TokenUsage | null;
    persistenceStatus: 'not_started' | 'success' | 'failed';
    persistence: Stage3PersistenceResult | null;
    error: string | null;
    warningCount: number;
    duplicateRankingCount: number;
    missingRankingCount: number;
    invalidRankingCount: number;
    deterministicFallbackCount: number;
    inputSnapshotHashes: Stage3JobResult['inputSnapshotHashes'];
    rankingStatuses: Stage3RankingStatuses;
    digestCategories: Record<string, DigestCategoryProgress>;
    categoryCorrections: DigestCategoryWarning[];
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
    legacy_prompt_versions: {
      event: STAGE3_EVENT_RANKING_PROMPT_VERSION,
      digest: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
      long_form: STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
    },
    published_within_hours: value.publishedWithinHours,
    event_group_count: value.eventGroupCount,
    event_selected_count: value.eventSelectedCount,
    digest_input_count: value.digestInputCount,
    digest_after_consolidation: value.digestAfterConsolidation,
    digest_count_by_category: value.digestCategoryCounts,
    long_form_count: value.longFormCount,
    llm_call_count: value.llmCallCount,
    retry_count: value.retryCount,
    llm_duration_ms: value.llmDurationMs,
    input_tokens: value.tokenUsage?.inputTokens ?? null,
    output_tokens: value.tokenUsage?.outputTokens ?? null,
    total_tokens: value.tokenUsage?.totalTokens ?? null,
    cached_input_tokens: value.tokenUsage?.cachedInputTokens ?? null,
    token_usage_complete: value.tokenUsage?.usageComplete ?? null,
    persistence_status: value.persistenceStatus,
    persistence: value.persistence,
    warning_count: value.warningCount,
    duplicate_ranking_count: value.duplicateRankingCount,
    missing_ranking_count: value.missingRankingCount,
    invalid_ranking_count: value.invalidRankingCount,
    deterministic_fallback_count: value.deterministicFallbackCount,
    input_snapshot_hashes: value.inputSnapshotHashes && {
      event: value.inputSnapshotHashes.event,
      digest: value.inputSnapshotHashes.digest,
      long_form: value.inputSnapshotHashes.longForm,
    },
    ranking_statuses: value.rankingStatuses,
    digest_categories: value.digestCategories,
    category_corrections: value.categoryCorrections,
    error: value.error,
  });
}

function snapshotHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isUsableRankingStatus(status: Stage3RankingStatus): boolean {
  return status === 'success' || status === 'skipped';
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
  const root = join(rootDir, 'runtime/stage3');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const run = await readJson<Record<string, unknown>>(join(root, entry.name, 'run.json'));
      const hashes = run.input_snapshot_hashes as Record<string, unknown> | undefined;
      const statuses = run.ranking_statuses as
        Partial<Record<keyof Stage3RankingStatuses, unknown>> | undefined;
      if (
        run.daily_date !== dailyDate ||
        hashes?.event !== eventHash ||
        typeof run.event_review_run_id !== 'string'
      )
        continue;
      const event = rankingStatus(statuses?.event);
      const digest = rankingStatus(statuses?.digest);
      const longForm = rankingStatus(statuses?.long_form);
      if (!event || !digest || !longForm) continue;
      return {
        runDir: join(root, entry.name),
        runId: typeof run.run_id === 'string' ? run.run_id : entry.name,
        eventReviewRunId: run.event_review_run_id,
        hashes: {
          event: hashes.event,
          digest: typeof hashes.digest === 'string' ? hashes.digest : undefined,
          longForm: typeof hashes.long_form === 'string' ? hashes.long_form : undefined,
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
  return value === 'pending' || value === 'success' || value === 'failed' || value === 'skipped'
    ? value
    : null;
}

async function loadReusableEventRanking(
  pool: Pool,
  resume: Stage3ResumeArtifact,
  input: Stage3EventRankingInput,
): Promise<Awaited<ReturnType<typeof rankEvents>> | null> {
  const snapshot = await pool.query<{ count: string }>(
    'select count(*)::text as count from event_review_items where review_run_id=$1::uuid',
    [resume.eventReviewRunId],
  );
  if (Number(snapshot.rows[0]?.count ?? 0) === 0) return null;
  try {
    const output = await readJson<Stage3EventRankedOutput>(
      join(resume.runDir, 'events/ranking-output.json'),
    );
    const normalized = normalizeStage3EventRankingOutput(
      { ordered_ids: output.rankings.map((item) => item.id) },
      input.events.map((event) => event.id),
    );
    if (!normalized.success) return null;
    return {
      output: deriveStage3EventRankings(normalized.output),
      calls: 0,
      retries: 0,
      durationMs: 0,
      tokenUsage: null,
      diagnostics: {
        input_event_count: input.events.length,
        returned_ranking_count: output.rankings.length,
        model_valid_id_count: output.rankings.length,
        duplicate_ids: [],
        invalid_ids: [],
        fallback_ids: [],
      },
      warnings: emptyRankingWarnings(),
    };
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function hasMatchingDigestCategory(
  dir: string,
  inputs: Record<string, Stage3DigestRankingInput>,
  maps: Stage3IdMap['digest'],
) {
  try {
    const priorMap = await readJson<Stage3IdMap>(join(dir, 'id-map.json'));
    for (const input of Object.values(inputs)) {
      try {
        const prior = await readJson<Stage3DigestRankingInput>(
          join(dir, 'digest', `${toSlug(input.category)}-input.json`),
        );
        if (
          priorMap.digest[input.category] &&
          stableDigestHash(prior, priorMap.digest[input.category]) ===
            stableDigestHash(input, maps[input.category])
        )
          return true;
      } catch (e) {
        if (isMissingPathError(e) || e instanceof SyntaxError || e instanceof TypeError) continue;
        throw e;
      }
    }
  } catch (e) {
    if (!isMissingPathError(e) && !(e instanceof SyntaxError) && !(e instanceof TypeError)) throw e;
  }
  return false;
}

async function loadReusableLongFormRanking(
  resume: Stage3ResumeArtifact,
  input: Stage3LongFormRankingInput,
): Promise<Awaited<ReturnType<typeof rankLongForm>> | null> {
  try {
    const output = await readJson<Stage3RankingOutput>(
      join(resume.runDir, 'long-form/ranking-output.json'),
    );
    const normalized = normalizeStage3RankingOutput(
      output,
      input.candidates.map((candidate) => candidate.id),
    );
    if (!normalized.success) return null;
    return {
      output: normalized.output,
      calls: 0,
      retries: 0,
      durationMs: 0,
      tokenUsage: null,
      warnings: emptyRankingWarnings(),
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
    return (
      (leftIndex === -1 ? CATEGORY_ORDER.length : leftIndex) -
      (rightIndex === -1 ? CATEGORY_ORDER.length : rightIndex)
    );
  }

  return left.localeCompare(right);
}

function normalizeRuntimePath(rootDir: string, path: string): string {
  return path.startsWith('/') ? path : join(rootDir, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  if (path.endsWith('/run.json')) await writeRunFile(path, value as Record<string, unknown>);
  else await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toEventId(index: number): string {
  return `EV${String(index + 1).padStart(3, '0')}`;
}

function toDigestId(index: number): string {
  return `D${String(index + 1).padStart(3, '0')}`;
}

function toLongFormId(index: number): string {
  return `L${String(index + 1).padStart(3, '0')}`;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
