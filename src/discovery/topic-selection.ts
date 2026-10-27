import { getActiveMemories, formatMemories } from '../lib/memories.js';
import { withPromptBindings, databasePromptBinder } from '../lib/prompts/runtime.js';
import { productionPrompt } from '../lib/prompts/runtime.js';
// D2
import type { Pool } from 'pg';
import {
  createLlmClient,
  resolveProviderLlmModel,
  type LlmProvider,
  type LlmResponse,
} from '../processing/llm-client.js';
import {
  buildDiscoveryD2UserPrompt,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
} from '../prompts/discovery-topic-selection.js';
import {
  readDiscoveryDailyWindow,
  toDiscoveryInputContentIds,
  type DiscoveryInputItem,
  type DiscoveryWindowInput,
} from './daily-read-adapter.js';
import { recordDiscoveryDiagnostic } from './diagnostics.js';
import {
  resolveDiscoveryLlmProvider,
  resolveDiscoveryLlmTimeout,
  toDiscoveryRequestOptions,
} from './llm-config.js';
import {
  buildDiscoveryStageState,
  initialDiscoveryStageState,
  stageHasHistoricConfig,
  usageFromLlmResponse,
} from './execution-diagnostics.js';
import { getDiscoveryRun, updateDiscoveryBranchExecutionState } from './run-service.js';

export type DiscoveryDirectLead = {
  leadId: string;
  kind: 'direct';
  sourceContentId: string;
  url: string | null;
  rationale: string;
};

export type DiscoveryTopicLead = {
  leadId: string;
  kind: 'topic';
  question: string;
  rationale: string;
  newsContext: string;
  sourceContentIds: string[];
};

export type DiscoveryLead = DiscoveryDirectLead | DiscoveryTopicLead;

export type DiscoverySelectionOutput = {
  leads: DiscoveryLead[];
};

type RawDirectLead = Omit<DiscoveryDirectLead, 'leadId' | 'url'>;
type RawTopicLead = Omit<DiscoveryTopicLead, 'leadId'>;
type RawDiscoveryLead = RawDirectLead | RawTopicLead;

type DiscoveryD2Request = {
  model: string;
  instructions?: string;
  input: string;
  max_output_tokens: number;
  store: boolean;
  text: {
    format: {
      type: 'json_schema';
      name: string;
      description: string;
      schema: typeof discoveryD2OutputJsonSchema;
      strict: true;
    };
  };
};

export type RunDiscoveryD2Options = {
  provider?: LlmProvider;
  timeoutMs?: number;
  input?: DiscoveryWindowInput;
  request?: (request: DiscoveryD2Request, options: { timeout?: number }) => Promise<LlmResponse>;
};

export type RunDiscoveryD2Result = {
  selection: DiscoverySelectionOutput;
  provider: LlmProvider;
  model: string;
  promptVersion: string;
  responseId: string;
  apiMode: LlmResponse['api_mode'];
  requestElapsedMs: number;
  timeoutMs: number | undefined;
  tokenUsage: LlmResponse['usage'] | null;
};

export const discoveryD2OutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['leads'],
  properties: {
    leads: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'sourceContentId',
          'question',
          'rationale',
          'newsContext',
          'sourceContentIds',
        ],
        properties: {
          kind: { type: 'string', enum: ['direct', 'topic'] },
          sourceContentId: { type: ['string', 'null'] },
          question: { type: ['string', 'null'] },
          rationale: { type: 'string' },
          newsContext: { type: ['string', 'null'] },
          sourceContentIds: {
            type: ['array', 'null'],
            items: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

/** Shared request preparation only: no model call, Run mutation, or Prompt binding writes. */
export async function prepareDiscoveryD2Request(
  db: Pick<Pool, 'query'>,
  input: DiscoveryWindowInput,
  model: string,
) {
  const memories = await getActiveMemories(db, { types: ['general', 'topic'] });
  const businessInput = buildDiscoveryD2UserPrompt(input, formatMemories(memories));
  const prompt = await productionPrompt('discovery.d2.topic_selection', businessInput);
  const request: DiscoveryD2Request = {
    model,
    ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
    input: prompt.input,
    max_output_tokens: 4_000,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'discovery_topic_selection',
        description: 'Direct and Topic leads selected from two Daily Briefs.',
        schema: discoveryD2OutputJsonSchema,
        strict: true,
      },
    },
  };
  return { request, promptVersion: prompt.versionId, businessInput, memories };
}

export async function runDiscoveryD2(
  pool: Pool,
  runId: string,
  options: RunDiscoveryD2Options = {},
): Promise<RunDiscoveryD2Result> {
  return withPromptBindings(pool, databasePromptBinder(pool, 'discovery', runId), () =>
    runDiscoveryD2Bound(pool, runId, options),
  );
}
async function runDiscoveryD2Bound(
  pool: Pool,
  runId: string,
  options: RunDiscoveryD2Options = {},
): Promise<RunDiscoveryD2Result> {
  const run = await getDiscoveryRun(pool, runId);
  if (!run || run.status !== 'running' || run.runType !== 'regular') {
    throw new Error('D2 requires a running regular Discovery Run.');
  }
  if (!run.windowStartDate || !run.windowEndDate || !run.inputContentIds) {
    throw new Error('D2 requires a fixed Daily window and input content membership.');
  }

  const currentInput =
    options.input ??
    (await readDiscoveryDailyWindow(pool, [run.windowStartDate, run.windowEndDate]));
  const input = restrictToFrozenMembership(currentInput, run.inputContentIds);
  const provider = resolveDiscoveryLlmProvider('d2', options.provider);
  const model = resolveProviderLlmModel(provider);
  const timeoutMs = resolveDiscoveryLlmTimeout('d2', options.timeoutMs);
  const client = options.request ? null : createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const request = options.request ?? client?.structured.create;
  if (!request) throw new Error('D2 LLM request function is unavailable.');

  const metadata = { provider, model, apiMode: 'chat_completions' };
  const prior = initialDiscoveryStageState(
    run.executionState.d2,
    stageHasHistoricConfig(run.configSnapshot, 'd2'),
  );
  const stageStartedAt = Date.now();
  await updateDiscoveryBranchExecutionState(
    pool,
    runId,
    'd2',
    buildDiscoveryStageState({
      status: 'running',
      endReason: null,
      errorSummary: null,
      metadata,
      prior,
    }),
  );
  let responseUsage: LlmResponse['usage'] | null = null;

  try {
    const prepared = await prepareDiscoveryD2Request(pool, input, model);
    const requestStartedAt = Date.now();
    const response = await request(prepared.request, toDiscoveryRequestOptions(timeoutMs));
    responseUsage = response.usage ?? null;

    const validatedSelection = parseAndValidateDiscoveryD2Output(response.output_text, input);
    const selection = await attachDirectLeadUrls(pool, validatedSelection);
    await persistDiscoveryD2Output(
      pool,
      runId,
      selection,
      {
        provider,
        model,
        timeoutMs,
        promptVersion: prepared.promptVersion,
        editorialPromptVersion: DISCOVERY_EDITORIAL_PROMPT_VERSION,
      },
      buildDiscoveryStageState({
        status: 'completed',
        endReason: selection.leads.length > 0 ? 'candidates_found' : 'no_candidates',
        errorSummary: null,
        metadata: { ...metadata, apiMode: response.api_mode },
        prior,
        attemptUsage: usageFromLlmResponse(responseUsage),
        attemptElapsedMs: Date.now() - stageStartedAt,
        completedAt: new Date().toISOString(),
      }),
    );

    return {
      selection,
      provider,
      model,
      promptVersion: prepared.promptVersion,
      responseId: response.id,
      apiMode: response.api_mode,
      requestElapsedMs: Date.now() - requestStartedAt,
      timeoutMs,
      tokenUsage: responseUsage,
    };
  } catch (error) {
    await updateDiscoveryBranchExecutionState(
      pool,
      runId,
      'd2',
      buildDiscoveryStageState({
        status: 'failed',
        endReason: 'error',
        errorSummary: toErrorMessage(error),
        metadata,
        prior,
        attemptUsage: usageFromLlmResponse(responseUsage),
        attemptElapsedMs: Date.now() - stageStartedAt,
        completedAt: new Date().toISOString(),
      }),
    );
    throw error;
  } finally {
    await client?.close();
  }
}

export function parseAndValidateDiscoveryD2Output(
  rawOutput: string,
  input: DiscoveryWindowInput,
): DiscoverySelectionOutput {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(
      `D2 structured output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = requireExactObject(value, ['leads'], 'D2 output');
  if (!Array.isArray(root.leads)) throw new Error('D2 output.leads must be an array.');
  if (root.leads.length > 8) throw new Error('D2 output contains more than 8 leads.');

  const itemsById = new Map(
    input.days
      .flatMap((day) => [...day.events, ...day.digests, ...day.longForm])
      .map((item) => [item.id, item]),
  );
  const directSourceIds = new Set<string>();
  const leads = root.leads.map((lead, index) => {
    const validated = validateLead(lead, index, itemsById);
    if (validated.kind === 'direct') {
      if (directSourceIds.has(validated.sourceContentId)) {
        throw new Error(`D2 output repeats Direct sourceContentId: ${validated.sourceContentId}`);
      }
      directSourceIds.add(validated.sourceContentId);
    }
    return validated;
  });

  return {
    leads: leads.map((lead, index): DiscoveryLead => {
      const leadId = `lead-${String(index + 1).padStart(2, '0')}`;
      return lead.kind === 'direct' ? { leadId, ...lead, url: null } : { leadId, ...lead };
    }),
  };
}

async function attachDirectLeadUrls(
  pool: Pool,
  selection: DiscoverySelectionOutput,
): Promise<DiscoverySelectionOutput> {
  const directIds = selection.leads.flatMap((lead) =>
    lead.kind === 'direct' ? [lead.sourceContentId] : [],
  );
  if (directIds.length === 0) return selection;

  const result = await pool.query<{ id: string; url: string | null }>(
    `select pc.id, ra.url
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = any($1::uuid[])
        and pc.routing in ('digest', 'long_form')`,
    [directIds],
  );
  const urlsByContentId = new Map(result.rows.map((row) => [row.id, row.url?.trim() || null]));
  const missingSource = directIds.find((id) => !urlsByContentId.has(id));
  if (missingSource) {
    throw new Error(`D2 Direct source is no longer readable: ${missingSource}`);
  }

  return {
    leads: selection.leads.map((lead) =>
      lead.kind === 'direct'
        ? { ...lead, url: urlsByContentId.get(lead.sourceContentId) ?? null }
        : lead,
    ),
  };
}

function validateLead(
  value: unknown,
  index: number,
  itemsById: Map<string, DiscoveryInputItem>,
): RawDiscoveryLead {
  const base = requireObject(value, `D2 lead ${index + 1}`);
  const lead = requireExactObject(
    value,
    ['kind', 'sourceContentId', 'question', 'rationale', 'newsContext', 'sourceContentIds'],
    `D2 lead ${index + 1}`,
  );
  if (base.kind === 'direct') {
    requireNull(lead.question, 'D2 direct lead question');
    requireNull(lead.newsContext, 'D2 direct lead newsContext');
    requireNull(lead.sourceContentIds, 'D2 direct lead sourceContentIds');
    const sourceContentId = requireNonEmptyString(lead.sourceContentId, 'sourceContentId');
    const source = itemsById.get(sourceContentId);
    if (!source) throw new Error(`D2 direct lead references unknown ID: ${sourceContentId}`);
    if (source.kind === 'event') {
      throw new Error(`D2 direct lead cannot reference Event: ${sourceContentId}`);
    }
    if (!source.directEligible) {
      throw new Error(`D2 direct lead is not eligible: ${sourceContentId}`);
    }
    return {
      kind: 'direct',
      sourceContentId,
      rationale: requireNonEmptyString(lead.rationale, 'rationale'),
    };
  }

  if (base.kind !== 'topic') {
    throw new Error(`D2 lead ${index + 1} has unsupported kind.`);
  }
  requireNull(lead.sourceContentId, 'D2 topic lead sourceContentId');
  if (!Array.isArray(lead.sourceContentIds) || lead.sourceContentIds.length === 0) {
    throw new Error('D2 topic lead must reference at least one input content ID.');
  }
  const sourceContentIds = lead.sourceContentIds.map((id) =>
    requireNonEmptyString(id, 'sourceContentIds[]'),
  );
  if (new Set(sourceContentIds).size !== sourceContentIds.length) {
    throw new Error('D2 topic lead repeats sourceContentIds.');
  }
  const unknownId = sourceContentIds.find((id) => !itemsById.has(id));
  if (unknownId) throw new Error(`D2 topic lead references unknown ID: ${unknownId}`);

  return {
    kind: 'topic',
    question: requireNonEmptyString(lead.question, 'question'),
    rationale: requireNonEmptyString(lead.rationale, 'rationale'),
    newsContext: requireNonEmptyString(lead.newsContext, 'newsContext'),
    sourceContentIds,
  };
}

function requireNull(value: unknown, label: string): void {
  if (value !== null) throw new Error(`${label} must be null.`);
}

function restrictToFrozenMembership(
  input: DiscoveryWindowInput,
  frozen: NonNullable<Awaited<ReturnType<typeof getDiscoveryRun>>>['inputContentIds'],
): DiscoveryWindowInput {
  if (!frozen) throw new Error('Discovery input membership is unavailable.');
  const expected = {
    event: new Set(frozen.event.map((item) => item.id)),
    digest: new Set(frozen.digest.map((item) => item.id)),
    long_form: new Set(frozen.longForm.map((item) => item.id)),
  };
  const available = new Set(
    input.days
      .flatMap((day) => [...day.events, ...day.digests, ...day.longForm])
      .map((item) => item.id),
  );
  const missing = [...expected.event, ...expected.digest, ...expected.long_form].filter(
    (id) => !available.has(id),
  );
  if (missing.length > 0) {
    throw new Error(`D2 fixed input membership is no longer readable: ${missing.join(', ')}`);
  }

  const days = input.days.map((day) => ({
    ...day,
    events: day.events.filter((item) => expected.event.has(item.id)),
    digests: day.digests.filter((item) => expected.digest.has(item.id)),
    longForm: day.longForm.filter((item) => expected.long_form.has(item.id)),
  })) as DiscoveryWindowInput['days'];

  return { ...input, days, contentIds: toDiscoveryInputContentIds(days) };
}

async function persistDiscoveryD2Output(
  pool: Pool,
  runId: string,
  selection: DiscoverySelectionOutput,
  config: Record<string, unknown>,
  executionState: Parameters<typeof updateDiscoveryBranchExecutionState>[3],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update discovery_runs
        set selection_output = $2::jsonb,
            config_snapshot = jsonb_set(
              coalesce(config_snapshot, '{}'::jsonb),
              '{d2}',
              $3::jsonb,
              true
            ),
            updated_at = now()
        where id = $1::uuid and status = 'running'`,
      [runId, JSON.stringify(selection), JSON.stringify(config)],
    );
    if (result.rowCount !== 1) {
      throw new Error('D2 could not persist output for the running Discovery Run.');
    }
    for (const lead of selection.leads) {
      if (lead.kind !== 'direct' || lead.url) continue;
      await recordDiscoveryDiagnostic(client, {
        runId,
        name: 'd2_direct_source_check',
        status: 'warning',
        payload: {
          leadId: lead.leadId,
          sourceContentId: lead.sourceContentId,
          reason: 'missing_url',
        },
      });
    }
    await updateDiscoveryBranchExecutionState(client, runId, 'd2', executionState);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactObject(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  const object = requireObject(value, label);
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
  return object;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`D2 ${label} must be a non-empty string.`);
  }
  return value.trim();
}
