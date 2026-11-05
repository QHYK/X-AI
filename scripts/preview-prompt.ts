import { pathToFileURL } from 'node:url';
import { getDatabasePool } from '../src/db/index.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { withPromptBindings } from '../src/lib/prompts/runtime.js';
import { prepareDiscoveryD2Request } from '../src/discovery/topic-selection.js';
import {
  readDiscoveryDailyWindow,
  validateDiscoveryDailyDates,
  type DiscoveryDailyDatePair,
} from '../src/discovery/daily-read-adapter.js';
import {
  resolveDiscoveryLlmProvider,
  resolveDiscoveryLlmTimeout,
  toDiscoveryRequestOptions,
} from '../src/discovery/llm-config.js';
import {
  buildChatCompletionRequest,
  resolveProviderLlmModel,
  resolveStageLlmModel,
  resolveStageLlmProvider,
  type LlmProvider,
} from '../src/processing/llm-client.js';

import type { Pool } from 'pg';
import { getActiveMemories, formatMemories } from '../src/lib/memories.js';
import { resolveDailyScope } from '../src/lib/daily-scope.js';
import {
  createStage1MicroBatches,
  loadStage1EvaluationArticles,
  resolveStage1BatchConfig,
  stage1ProviderForLogicalBatch,
} from '../src/processing/stage1-job.js';
import { buildStage1BatchInput } from '../src/processing/stage1-contract.js';
import { prepareStage1Request } from '../src/processing/stage1-llm.js';
import { prepareStage3EventRequest } from '../src/processing/stage3-event-ranking-llm.js';
import { buildStage3EventRankingInputFromDb } from '../src/processing/stage3-job.js';
import { resolveStageLlmRuntimeConfig } from '../src/processing/stage-llm-runtime-config.js';

export type PreviewStep = 'd2' | 'stage1' | 'stage3:event';
const usage =
  'Usage: npm run test:prompt -- D2|stage1|stage3:event [--date=YYYY-MM-DD | --dates=YYYY-MM-DD,YYYY-MM-DD]';

export function parsePreviewArgs(args: string[]) {
  const step = args[0]?.toLowerCase();
  if (!['d2', 'stage1', 'stage3:event'].includes(step) || args.length > 2) throw new Error(usage);
  const options: { date?: string; dates?: DiscoveryDailyDatePair } = {};
  if (args[1]) {
    if (step === 'd2' && args[1].startsWith('--dates=')) {
      const values = args[1].slice('--dates='.length).split(',');
      if (values.length !== 2 || values.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)))
        throw new Error(usage);
      options.dates = validateDiscoveryDailyDates([values[0], values[1]]);
    } else if (step !== 'd2' && args[1].startsWith('--date=')) {
      const date = args[1].slice('--date='.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(usage);
      options.date = resolveDailyScope(date).dailyDate;
    } else throw new Error(usage);
  }
  return { step: step as PreviewStep, options };
}

type Prepared = {
  request: Parameters<typeof buildChatCompletionRequest>[1];
  businessInput: string;
};

/** Only redact the exact JSON insertion in user messages; never mutate the real request. */
export function displayPromptRequest(
  prepared: Prepared,
  provider: LlmProvider,
  field: 'contents' | 'articles' | 'events',
) {
  const parameters = buildChatCompletionRequest(provider, prepared.request);
  const input = JSON.parse(prepared.businessInput);
  if (!Array.isArray(input[field]))
    throw new Error('Cannot safely locate business input for display.');
  const displayedInput = JSON.stringify(
    { ...input, [field]: field === 'contents' ? {} : [] },
    null,
    prepared.businessInput.includes('\n') ? 2 : undefined,
  );
  let found = false;
  const messages = parameters.messages.map((message) => {
    if (
      message.role !== 'user' ||
      typeof message.content !== 'string' ||
      !message.content.includes(prepared.businessInput)
    )
      return message;
    found = true;
    return {
      ...message,
      content: message.content.replaceAll(prepared.businessInput, displayedInput),
    };
  });
  if (!found)
    throw new Error('Cannot safely locate business input for display; refusing to print it.');
  return { ...parameters, messages };
}

/** One read-only preview path; Run bindings and model clients are never created. */
export async function preparePromptPreview(
  db: Pick<Pool, 'query'>,
  step: PreviewStep,
  options: { date?: string; dates?: DiscoveryDailyDatePair } = {},
) {
  return withPromptBindings(
    db,
    (_key, active) => active(db),
    async () => {
      if (step === 'd2') {
        let dates = options.dates;
        if (!dates) {
          const result = await db.query<{ daily_date: string }>(
            `select daily_date::text as daily_date from pipeline_runs
           where step in ('daily', 'stage4') and status = 'success' and daily_date is not null
           group by daily_date order by daily_date desc limit 2`,
          );
          if (result.rows.length !== 2)
            throw new Error('Two completed Daily dates are required; provide --dates explicitly.');
          dates = validateDiscoveryDailyDates([
            result.rows[1].daily_date,
            result.rows[0].daily_date,
          ]);
        }
        const input = await readDiscoveryDailyWindow(db, dates);
        const provider = resolveDiscoveryLlmProvider('d2');
        const prepared = await prepareDiscoveryD2Request(
          db,
          input,
          resolveProviderLlmModel(provider),
        );
        return {
          ...prepared,
          provider,
          field: 'contents' as const,
          scope: dates.join(','),
          requestOptions: toDiscoveryRequestOptions(resolveDiscoveryLlmTimeout('d2')),
        };
      }
      const scope = resolveDailyScope(options.date);
      const memories = await getActiveMemories(db, { types: ['content'] });
      const memoryContext = formatMemories(memories);
      if (step === 'stage1') {
        // Include already processed articles for inspection; never modify the pending queue.
        const articles = await loadStage1EvaluationArticles(db, scope);
        const batch = createStage1MicroBatches(articles, resolveStage1BatchConfig())[0];
        if (!batch) throw new Error(`No Stage1 articles for ${scope.dailyDate}; provide --date.`);
        const provider = stage1ProviderForLogicalBatch(1, resolveStageLlmProvider('stage1'));
        const prepared = await prepareStage1Request(
          buildStage1BatchInput(batch),
          resolveProviderLlmModel(provider),
          memoryContext,
        );
        return {
          ...prepared,
          promptVersion: prepared.prompt.versionId,
          memories,
          provider,
          field: 'articles' as const,
          scope: scope.dailyDate,
          requestOptions: { timeout: resolveStageLlmRuntimeConfig('stage1').timeoutMs },
        };
      }
      const { input } = await buildStage3EventRankingInputFromDb(db, scope.dailyDate);
      const provider = resolveStageLlmProvider('stage3');
      const prepared = await prepareStage3EventRequest(
        input,
        resolveStageLlmModel('stage3'),
        memoryContext,
      );
      return {
        ...prepared,
        promptVersion: prepared.prompt.versionId,
        memories,
        provider,
        field: 'events' as const,
        scope: scope.dailyDate,
        requestOptions: { timeout: resolveStageLlmRuntimeConfig('stage3').timeoutMs },
      };
    },
    { binding: 'active' },
  );
}

async function main() {
  const { step, options } = parsePreviewArgs(process.argv.slice(2));
  loadPipelineEnvironment();
  const pool = getDatabasePool();
  try {
    const client = await pool.connect();
    try {
      // All reads share one consistent snapshot; PostgreSQL itself forbids accidental writes.
      await client.query('begin isolation level repeatable read read only');
      const prepared = await preparePromptPreview(client, step, options);
      const parameters = displayPromptRequest(prepared, prepared.provider, prepared.field);
      console.error(
        `[Prompt Preview] step=${step} provider=${prepared.provider} version=${prepared.promptVersion} memories=${prepared.memories.length} types=${[...new Set(prepared.memories.map((m) => m.type))].join(',') || 'none'} dates=${prepared.scope} omitted=${prepared.field}`,
      );
      console.log('chat.completions.create parameters:');
      console.log(JSON.stringify(parameters, null, 2));
      console.log('chat.completions.create requestOptions:');
      console.log(JSON.stringify(prepared.requestOptions, null, 2));
    } finally {
      // Also rolls back on failure before returning the connection.
      try {
        await client.query('rollback');
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      'Prompt Preview failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exitCode = 1;
  });
}
