/**
 * X-AI-field 的 Drizzle 数据模型定义。
 *
 * 描述采集输入、Stage 处理结果、最终 Event 和反馈之间的持久化关系及基础索引。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export type DiscoveryInputContentIds = {
  event: Array<{ dailyDate: string; id: string }>;
  digest: Array<{ dailyDate: string; id: string }>;
  longForm: Array<{ dailyDate: string; id: string }>;
};

export type DiscoveryStage = 'd2' | 'd3' | 'd4' | 'd5';

export type DiscoveryStageUsage = {
  /** Null means an earlier request existed but its exact total is unavailable. */
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Included in inputTokens; never add this to a total token count. */
  cachedInputTokens: number | null;
  /** False whenever any request in the accumulated stage lacks complete usage data. */
  usageComplete: boolean;
};

export type DiscoveryBranchExecutionState = {
  status: 'running' | 'completed' | 'failed';
  endReason:
    | 'candidates_found'
    | 'no_candidates'
    | 'timeout'
    | 'budget_exhausted'
    | 'tool_failure'
    | 'error'
    | null;
  completedAt: string | null;
  errorSummary: string | null;
  provider: string | null;
  model: string | null;
  apiMode: string | null;
  /** Accumulated known elapsed time across retries; null when historic timing is unknown. */
  elapsedMs: number | null;
  usage: DiscoveryStageUsage;
};

export type DiscoveryExecutionState = Partial<
  Record<DiscoveryStage, DiscoveryBranchExecutionState>
>;

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  sourceType: text('source_type'),
  url: text('url').notNull(),
  collectionMethod: text('collection_method').notNull(),
  priority: text('priority').notNull(),
  enabled: boolean('enabled').notNull(),
  eventCandidate: boolean('event_candidate').notNull(),
  sourceDigestCandidate: boolean('source_digest_candidate').notNull(),
  language: text('language').notNull(),
  availability: text('availability'),
  notes: text('notes'),
  ...timestamps,
});

export const rawArticles = pgTable(
  'raw_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceItemOriginId: text('source_item_origin_id'),
    title: text('title').notNull(),
    url: text('url'),
    author: text('author'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    contentText: text('content_text'),
    fullContentText: text('full_content_text'),
    imageUrl: text('image_url'),
    sourceTags: text('source_tags').array(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    stage1Status: text('stage1_status').notNull(),
    stage1ProcessedAt: timestamp('stage1_processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
  },
  (table) => [
    index('raw_articles_source_id_idx').on(table.sourceId),
    index('raw_articles_published_at_idx').on(table.publishedAt),
    index('raw_articles_collected_at_idx').on(table.collectedAt),
    index('raw_articles_stage1_status_idx').on(table.stage1Status),
  ],
);

/** Stage 3 Event Ranking 的可审核 snapshot item；不复制最终 Event 内容。 */
export const eventReviewItems = pgTable(
  'event_review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewRunId: uuid('review_run_id').notNull(),
    dailyDate: date('daily_date').notNull(),
    eventGroupId: uuid('event_group_id').references(() => eventGroups.id, { onDelete: 'set null' }),
    eventTempId: text('event_temp_id').notNull(),
    eventHint: text('event_hint').notNull(),
    aiRank: integer('ai_rank').notNull(),
    displayRank: integer('display_rank').notNull(),
    memberContentIds: uuid('member_content_ids').array().notNull(),
    ...timestamps,
  },
  (table) => [
    index('event_review_items_daily_date_idx').on(table.dailyDate),
    uniqueIndex('event_review_items_run_temp_unique').on(table.reviewRunId, table.eventTempId),
    uniqueIndex('event_review_items_run_ai_rank_unique').on(table.reviewRunId, table.aiRank),
    uniqueIndex('event_review_items_run_display_rank_unique').on(
      table.reviewRunId,
      table.displayRank,
    ),
    uniqueIndex('event_review_items_run_group_unique').on(table.reviewRunId, table.eventGroupId),
  ],
);

/** Stage 2 对某期 Daily 的完整、可替换 Event Group snapshot。 */
export const eventGroups = pgTable(
  'event_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dailyDate: date('daily_date').notNull(),
    eventHint: text('event_hint').notNull(),
    ...timestamps,
  },
  (table) => [index('event_groups_daily_date_idx').on(table.dailyDate)],
);

export const eventGroupItems = pgTable(
  'event_group_items',
  {
    eventGroupId: uuid('event_group_id')
      .notNull()
      .references(() => eventGroups.id, { onDelete: 'cascade' }),
    processedContentId: uuid('processed_content_id')
      .notNull()
      .references(() => processedContents.id),
  },
  (table) => [
    uniqueIndex('event_group_items_group_content_unique').on(
      table.eventGroupId,
      table.processedContentId,
    ),
  ],
);

export const stage4Runs = pgTable(
  'stage4_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dailyDate: date('daily_date').notNull(),
    reviewRunId: uuid('review_run_id').notNull(),
    status: text('status').notNull(),
    promptVersions: jsonb('prompt_versions').$type<Record<string, string>>().notNull().default({}),
    expectedCount: integer('expected_count').notNull(),
    successCount: integer('success_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'stage4_runs_prompt_versions_object_check',
      sql`jsonb_typeof(${table.promptVersions}) = 'object'`,
    ),
    index('stage4_runs_daily_date_idx').on(table.dailyDate),
    uniqueIndex('stage4_runs_review_run_unique').on(table.reviewRunId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventDate: date('event_date').notNull(),
    title: text('title').notNull(),
    titleZh: text('title_zh').notNull(),
    tags: text('tags').array(),
    tagsZh: text('tags_zh').array(),
    entities: text('entities').array(),
    entitiesZh: text('entities_zh').array(),
    summary: text('summary').notNull(),
    summaryZh: text('summary_zh').notNull(),
    sourcePerspectives: jsonb('source_perspectives').notNull(),
    externalContext: jsonb('external_context'),
    // 新生成的最终 Event 指向其确切的 Stage 3 Review snapshot item，避免依赖成员集合猜测关联。
    eventReviewItemId: uuid('event_review_item_id').references(() => eventReviewItems.id),
    stage4RunId: uuid('stage4_run_id').references(() => stage4Runs.id),
    publicationStatus: text('publication_status').notNull().default('published'),
    aiRank: integer('ai_rank'),
    displayRank: integer('display_rank'),
    ...timestamps,
  },
  (table) => [
    index('events_event_date_idx').on(table.eventDate),
    index('events_display_rank_idx').on(table.displayRank),
    index('events_stage4_run_id_idx').on(table.stage4RunId),
    index('events_publication_status_idx').on(table.publicationStatus),
    uniqueIndex('events_run_review_item_unique').on(table.stage4RunId, table.eventReviewItemId),
  ],
);

export const processedContents = pgTable(
  'processed_contents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rawArticleId: uuid('raw_article_id')
      .notNull()
      .references(() => rawArticles.id),
    dailyDate: date('daily_date').notNull(),
    routing: text('routing').notNull(),
    category: text('category').notNull(),
    tags: text('tags').array(),
    entities: text('entities').array(),
    entitiesZh: text('entities_zh').array(),
    titleZh: text('title_zh'),
    summary: text('summary'),
    summaryZh: text('summary_zh'),
    eventId: uuid('event_id').references(() => events.id),
    aiRank: integer('ai_rank'),
    displayRank: integer('display_rank'),
    putBackAt: timestamp('put_back_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('processed_contents_raw_article_id_unique').on(table.rawArticleId),
    index('processed_contents_routing_idx').on(table.routing),
    index('processed_contents_event_id_idx').on(table.eventId),
    index('processed_contents_display_rank_idx').on(table.displayRank),
    index('processed_contents_daily_date_idx').on(table.dailyDate),
    check(
      'processed_contents_routing_check',
      sql`${table.routing} in ('event', 'digest', 'long_form', 'inspiration')`,
    ),
    check(
      'processed_contents_put_back_check',
      sql`${table.putBackAt} is null or (${table.routing} = 'digest' and ${table.aiRank} is null and ${table.displayRank} is not null)`,
    ),
  ],
);

/** 用户按需生成且已通过 Read More 输出校验的详细中文导读。 */
export const contentReadMore = pgTable(
  'content_read_more',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentId: uuid('content_id')
      .notNull()
      .references(() => processedContents.id, { onDelete: 'cascade' }),
    summaryZh: text('summary_zh').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('content_read_more_content_id_unique').on(table.contentId)],
);

export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  feedbackType: text('feedback_type').notNull(),
  beforeValue: jsonb('before_value'),
  afterValue: jsonb('after_value'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Durable, cross-machine execution summaries. Detailed artifacts remain on the local runtime filesystem. */
export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dailyDate: date('daily_date').notNull(),
    step: text('step').notNull(),
    status: text('status').notNull(),
    triggerSource: text('trigger_source').notNull(),
    provider: text('provider'),
    model: text('model'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    errorSummary: text('error_summary'),
    ...timestamps,
  },
  (table) => [
    index('pipeline_runs_daily_step_started_idx').on(table.dailyDate, table.step, table.startedAt),
  ],
);

/** Discovery execution and its fixed two-Daily input membership. */
export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => discoveryRuns.id),
    sourceLeadId: text('source_lead_id'),
    runType: text('run_type').notNull(),
    triggerSource: text('trigger_source').notNull(),
    status: text('status').notNull(),
    endReason: text('end_reason'),
    windowStartDate: date('window_start_date'),
    windowEndDate: date('window_end_date'),
    inputContentIds: jsonb('input_content_ids').$type<DiscoveryInputContentIds>(),
    selectionOutput: jsonb('selection_output').$type<Record<string, unknown>>(),
    configSnapshot: jsonb('config_snapshot').$type<Record<string, unknown>>(),
    executionState: jsonb('execution_state').$type<DiscoveryExecutionState>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorSummary: text('error_summary'),
    ...timestamps,
  },
  (table) => [
    index('discovery_runs_parent_run_id_idx').on(table.parentRunId),
    index('discovery_runs_status_started_at_idx').on(table.status, table.startedAt),
    check('discovery_runs_type_check', sql`${table.runType} in ('regular', 'single_lead', 'open')`),
    check(
      'discovery_runs_trigger_source_check',
      sql`${table.triggerSource} in ('schedule', 'manual')`,
    ),
    check(
      'discovery_runs_status_check',
      sql`${table.status} in ('pending', 'running', 'completed', 'partial', 'failed', 'blocked')`,
    ),
    check(
      'discovery_runs_end_reason_check',
      sql`${table.endReason} is null or ${table.endReason} in ('candidates_found', 'no_candidates', 'timeout', 'budget_exhausted', 'upstream_not_ready', 'error')`,
    ),
    check(
      'discovery_runs_relationship_check',
      sql`(
        (${table.runType} = 'regular' and ${table.parentRunId} is null and ${table.sourceLeadId} is null)
        or (${table.runType} = 'single_lead' and ${table.parentRunId} is not null and ${table.sourceLeadId} is not null)
        or (${table.runType} = 'open' and ${table.parentRunId} is not null and ${table.sourceLeadId} is null)
      )`,
    ),
    check(
      'discovery_runs_parent_not_self_check',
      sql`${table.parentRunId} is null or ${table.parentRunId} <> ${table.id}`,
    ),
    check(
      'discovery_runs_window_check',
      sql`(${table.windowStartDate} is null and ${table.windowEndDate} is null) or (${table.windowStartDate} is not null and ${table.windowEndDate} is not null and ${table.windowStartDate} <= ${table.windowEndDate})`,
    ),
    check(
      'discovery_runs_execution_state_object_check',
      sql`jsonb_typeof(${table.executionState}) = 'object'`,
    ),
  ],
);

/** Sanitized SDK trace data; never a source of business state. */
export const discoveryTraceSpans = pgTable(
  'discovery_trace_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    spanType: text('span_type').notNull(),
    name: text('name'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    status: text('status'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('discovery_trace_spans_run_started_idx').on(table.runId, table.startedAt),
    uniqueIndex('discovery_trace_spans_trace_span_unique').on(table.traceId, table.spanId),
  ],
);

/** Successful paid reads, independent of whether a discovered URL becomes a Candidate. */
export const discoveryFetchCache = pgTable(
  'discovery_fetch_cache',
  {
    normalizedUrl: text('normalized_url').primaryKey(),
    normalizedFinalUrl: text('normalized_final_url').notNull(),
    originalUrl: text('original_url').notNull(),
    finalUrl: text('final_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('success'),
    markdown: text('markdown').notNull(),
    isComplete: boolean('is_complete').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('discovery_fetch_cache_final_url_idx').on(table.normalizedFinalUrl),
    check(
      'discovery_fetch_cache_success_check',
      sql`${table.status} = 'success' and length(trim(${table.markdown})) > 0`,
    ),
    check(
      'discovery_fetch_cache_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

/** Discovery works and manually submitted works share metadata and human review. */
export const discoveryCandidates = pgTable(
  'discovery_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    discoveryPath: text('discovery_path').notNull(),
    sourceContentType: text('source_content_type'),
    sourceContentId: uuid('source_content_id'),
    sourceLeadId: text('source_lead_id'),
    topicContext: jsonb('topic_context').$type<Record<string, unknown>>(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url'),
    title: text('title'),
    titleZh: text('title_zh'),
    author: text('author'),
    publication: text('publication'),
    contentType: text('content_type'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    estimatedDurationMinutes: integer('estimated_duration_minutes'),
    summary: text('summary'),
    whyWorthReading: text('why_worth_reading'),
    extraInfo: jsonb('extra_info').$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    evaluation: jsonb('evaluation').$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    ...timestamps,
  },
  (table) => [
    index('discovery_candidates_run_path_idx').on(table.runId, table.discoveryPath),
    index('discovery_candidates_run_lead_idx').on(table.runId, table.sourceLeadId),
    index('discovery_candidates_normalized_url_idx').on(table.normalizedUrl),
    check(
      'discovery_candidates_path_check',
      sql`${table.discoveryPath} in ('direct', 'topic', 'open', 'manual')`,
    ),
    check(
      'discovery_candidates_run_check',
      sql`(${table.discoveryPath} = 'manual' and ${table.runId} is null)
        or (${table.discoveryPath} <> 'manual' and ${table.runId} is not null)`,
    ),
    check(
      'discovery_candidates_source_check',
      sql`(
        (${table.sourceContentType} is null and ${table.sourceContentId} is null)
        or (${table.sourceContentType} in ('event', 'processed_content') and ${table.sourceContentId} is not null)
      )`,
    ),
    check(
      'discovery_candidates_lead_check',
      sql`(
        (${table.discoveryPath} in ('direct', 'topic') and ${table.sourceLeadId} is not null)
        or (${table.discoveryPath} in ('open', 'manual') and ${table.sourceLeadId} is null)
      )`,
    ),
    check(
      'discovery_candidates_content_type_check',
      sql`${table.contentType} is null or ${table.contentType} in ('article', 'video', 'podcast')`,
    ),
    check(
      'discovery_candidates_status_check',
      sql`${table.status} in ('discovered', 'evaluated', 'selected', 'rejected', 'unverifiable')`,
    ),
    check(
      'discovery_candidates_extra_info_object_check',
      sql`jsonb_typeof(${table.extraInfo}) = 'object'`,
    ),
  ],
);

/** Candidates promoted into the human-review queue. */
export const inDepthCandidates = pgTable(
  'in_depth_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discoveryCandidateId: uuid('discovery_candidate_id')
      .notNull()
      .references(() => discoveryCandidates.id, { onDelete: 'cascade' }),
    reviewStatus: text('review_status').notNull(),
    editorialNotes: text('editorial_notes'),
    editorialSummary: text('editorial_summary'),
    editorialWhyWorthReading: text('editorial_why_worth_reading'),
    editorialExtraInfo: text('editorial_extra_info'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('in_depth_candidates_candidate_unique').on(table.discoveryCandidateId),
    index('in_depth_candidates_review_created_idx').on(table.reviewStatus, table.createdAt),
    check(
      'in_depth_candidates_review_status_check',
      sql`${table.reviewStatus} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);

/** 人工触发的模型评测所冻结的 Stage 输入；与正式业务表完全隔离。 */
export const evaluationInputs = pgTable(
  'evaluation_inputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dailyDate: date('daily_date').notNull(),
    stage: text('stage').notNull(),
    inputJson: jsonb('input_json').notNull(),
    inputHash: text('input_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evaluation_inputs_daily_stage_idx').on(table.dailyDate, table.stage)],
);

/** 同一冻结输入可由多个 Provider / Model 独立执行，失败不会影响其他 Run。 */
export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationInputId: uuid('evaluation_input_id')
      .notNull()
      .references(() => evaluationInputs.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // detached CLI 以该 PID 作为独立 process group leader；仅内部 Cancel API 使用，前端不会接触 PID。
    processPid: integer('process_pid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evaluation_runs_input_idx').on(table.evaluationInputId)],
);

/** 保存已通过当前 Stage Structured Output 校验的模型结果，不映射到正式内容表。 */
export const evaluationOutputs = pgTable(
  'evaluation_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationRunId: uuid('evaluation_run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    itemKey: text('item_key'),
    outputJson: jsonb('output_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evaluation_outputs_run_idx').on(table.evaluationRunId)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type RawArticle = typeof rawArticles.$inferSelect;
export type NewRawArticle = typeof rawArticles.$inferInsert;
export type ProcessedContent = typeof processedContents.$inferSelect;
export type NewProcessedContent = typeof processedContents.$inferInsert;
export type ContentReadMore = typeof contentReadMore.$inferSelect;
export type NewContentReadMore = typeof contentReadMore.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventReviewItem = typeof eventReviewItems.$inferSelect;
export type NewEventReviewItem = typeof eventReviewItems.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type EvaluationInput = typeof evaluationInputs.$inferSelect;
export type NewEvaluationInput = typeof evaluationInputs.$inferInsert;
export type EvaluationRun = typeof evaluationRuns.$inferSelect;
export type NewEvaluationRun = typeof evaluationRuns.$inferInsert;
export type EvaluationOutput = typeof evaluationOutputs.$inferSelect;
export type NewEvaluationOutput = typeof evaluationOutputs.$inferInsert;
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;
export type NewDiscoveryRun = typeof discoveryRuns.$inferInsert;
export type DiscoveryTraceSpan = typeof discoveryTraceSpans.$inferSelect;
export type NewDiscoveryTraceSpan = typeof discoveryTraceSpans.$inferInsert;
export type DiscoveryCandidate = typeof discoveryCandidates.$inferSelect;
export type NewDiscoveryCandidate = typeof discoveryCandidates.$inferInsert;
export type InDepthCandidate = typeof inDepthCandidates.$inferSelect;
export type NewInDepthCandidate = typeof inDepthCandidates.$inferInsert;

/** Prompt text/version infrastructure; production binding carriers are documented in Data Model. */
export const promptRegistry = pgTable(
  'prompt_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    workflow: text('workflow').notNull(),
    step: text('step').notNull(),
    requestType: text('request_type').notNull(),
    displayName: text('display_name').notNull(),
    activeVersionId: uuid('active_version_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('prompt_registry_key_unique').on(table.key),
    check('prompt_registry_kind_check', sql`${table.kind} in ('request', 'fragment')`),
    foreignKey({
      name: 'prompt_registry_active_same_registry_fk',
      columns: [table.activeVersionId, table.id],
      foreignColumns: [promptVersions.id, promptVersions.registryId],
    }),
  ],
);
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registryId: uuid('registry_id')
      .notNull()
      .references((): AnyPgColumn => promptRegistry.id),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    sourceCommit: text('source_commit'),
    legacyVersion: text('legacy_version'),
    changeNote: text('change_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('prompt_versions_registry_version_unique').on(table.registryId, table.version),
    uniqueIndex('prompt_versions_id_registry_unique').on(table.id, table.registryId),
    check('prompt_versions_version_check', sql`${table.version} > 0`),
    check('prompt_versions_status_check', sql`${table.status} in ('draft', 'published')`),
    check('prompt_versions_body_check', sql`jsonb_typeof(${table.body}) = 'object'`),
    check('prompt_versions_content_hash_check', sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
