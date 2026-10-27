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
  type LlmProvider,
} from '../src/processing/llm-client.js';

type Prepared = Awaited<ReturnType<typeof prepareDiscoveryD2Request>>;

/** Redact only the exact business-input insertion, after constructing the real request. */
export function displayD2Request(prepared: Prepared, provider: LlmProvider) {
  const parameters = buildChatCompletionRequest(provider, prepared.request);
  const input = JSON.parse(prepared.businessInput);
  if (!Array.isArray(input.contents) || !prepared.request.input.includes(prepared.businessInput))
    throw new Error('Cannot safely locate D2 Daily input for display; refusing to print it.');
  const displayedInput = JSON.stringify({ ...input, contents: {} });
  return {
    ...parameters,
    messages: parameters.messages.map((message) =>
      message.role === 'user' && typeof message.content === 'string'
        ? {
            ...message,
            content: message.content.replaceAll(prepared.businessInput, displayedInput),
          }
        : message,
    ),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !args[0].startsWith('--dates=')))
    throw new Error('Usage: npm run test:d2-input -- [--dates=YYYY-MM-DD,YYYY-MM-DD]');
  let dates: DiscoveryDailyDatePair | undefined;
  if (args[0]) {
    const values = args[0].slice('--dates='.length).split(',');
    if (values.length !== 2) throw new Error('--dates requires two Daily dates.');
    dates = validateDiscoveryDailyDates([values[0], values[1]]);
  }
  loadPipelineEnvironment();
  const pool = getDatabasePool();
  try {
    const client = await pool.connect();
    try {
      // All reads share one consistent snapshot; PostgreSQL itself forbids accidental writes.
      await client.query('begin isolation level repeatable read read only');
      if (!dates) {
        const result = await client.query<{ daily_date: string }>(
          `select daily_date::text as daily_date from pipeline_runs
           where step in ('daily', 'stage4') and status = 'success' and daily_date is not null
           group by daily_date order by daily_date desc limit 2`,
        );
        if (result.rows.length !== 2)
          throw new Error('Two completed Daily dates are required; provide --dates explicitly.');
        dates = validateDiscoveryDailyDates([result.rows[1].daily_date, result.rows[0].daily_date]);
      }
      const input = await readDiscoveryDailyWindow(client, dates);
      const provider = resolveDiscoveryLlmProvider('d2');
      const prepared = await withPromptBindings(
        client,
        (_key, active) => active(client),
        () => prepareDiscoveryD2Request(client, input, resolveProviderLlmModel(provider)),
        { binding: 'active' },
      );
      const parameters = displayD2Request(prepared, provider);
      const requestOptions = toDiscoveryRequestOptions(resolveDiscoveryLlmTimeout('d2'));
      console.error(
        `[D2 Input Preview] version=${prepared.promptVersion} memories=${prepared.memories.length} types=${prepared.memories.map((m) => m.type).join(',')} dates=${dates.join(',')}`,
      );
      console.log('chat.completions.create parameters:');
      console.log(JSON.stringify(parameters, null, 2));
      console.log('chat.completions.create requestOptions:');
      console.log(JSON.stringify(requestOptions, null, 2));
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
      'D2 Input Preview failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exitCode = 1;
  });
}
