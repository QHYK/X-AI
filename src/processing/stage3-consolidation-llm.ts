import { z } from 'zod';
import { productionPrompt } from '../lib/prompts/runtime.js';
import { createLlmClient, resolveStageLlmModel, resolveStageLlmProvider } from './llm-client.js';
import { resolveStageLlmRuntimeConfig } from './stage-llm-runtime-config.js';
import {
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  missingLlmTokenUsage,
  usageFromProvider,
  type LlmTokenUsage,
} from './llm-token-usage.js';
import { stage3Error } from './stage3-progress.js';
export const CONSOLIDATION_KEY = 'daily.stage3.event_digest_consolidation' as const;
export type ConsolidationInput = {
  category: string;
  events: { event_group_id: string; hint: string }[];
  candidates: { id: string; title: string; summary: string; source: string }[];
};
export const ConsolidationOutput = z
  .object({
    matches: z.array(
      z
        .object({
          event_group_id: z.uuid(),
          digest_content_ids: z.array(z.uuid()).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ConsolidationOutput = z.infer<typeof ConsolidationOutput>;
export function validateConsolidation(
  raw: unknown,
  input: ConsolidationInput,
): ConsolidationOutput {
  const output = ConsolidationOutput.parse(raw);
  const events = new Set(input.events.map((e) => e.event_group_id));
  const candidates = new Set(input.candidates.map((c) => c.id));
  const seen = new Set<string>();
  for (const match of output.matches) {
    if (!events.has(match.event_group_id)) throw new Error('Invalid consolidation Event Group ID.');
    for (const id of match.digest_content_ids) {
      if (!candidates.has(id) || seen.has(id))
        throw new Error('Unknown or duplicate consolidation Digest ID.');
      seen.add(id);
    }
  }
  return output;
}
export type ConsolidationResult = {
  output: ConsolidationOutput;
  calls: number;
  retries: number;
  durationMs: number;
  tokenUsage: LlmTokenUsage | null;
};
export class ConsolidationCallError extends Error {
  constructor(
    message: string,
    readonly metrics: Omit<ConsolidationResult, 'output'>,
  ) {
    super(message);
  }
}
export async function runStage3Consolidation(
  input: ConsolidationInput,
  options: { model: string },
): Promise<ConsolidationResult> {
  const config = resolveStageLlmRuntimeConfig('stage3');
  const model = options.model || resolveStageLlmModel('stage3');
  const prompt = await productionPrompt(CONSOLIDATION_KEY, JSON.stringify(input));
  const client = createLlmClient({
    provider: resolveStageLlmProvider('stage3'),
    timeoutMs: config.timeoutMs,
    maxRetries: 0,
  });
  const started = Date.now();
  let usage = emptyLlmTokenUsage(),
    calls = 0,
    error = '';
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['matches'],
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['event_group_id', 'digest_content_ids'],
          properties: {
            event_group_id: { type: 'string' },
            digest_content_ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
  try {
    for (let i = 0; i <= config.maxRetries; i++) {
      calls++;
      let received = false;
      try {
        const response = await client.structured.create(
          {
            model,
            ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt.input }] }],
            max_output_tokens: 8000,
            store: false,
            text: {
              format: { type: 'json_schema', name: 'stage3_consolidation', strict: true, schema },
            },
          },
          { timeout: config.timeoutMs },
        );
        received = true;
        usage = mergeLlmTokenUsage(usage, usageFromProvider(response.usage));
        return {
          output: validateConsolidation(JSON.parse(response.output_text), input),
          calls,
          retries: calls - 1,
          durationMs: Date.now() - started,
          tokenUsage: usage,
        };
      } catch (caught) {
        if (!received) usage = mergeLlmTokenUsage(usage, missingLlmTokenUsage());
        error = stage3Error(caught);
        if (/401|invalid_api_key|Incorrect API key/i.test(error)) break;
        if (i < config.maxRetries)
          await new Promise((r) => setTimeout(r, config.retryDelayMs * (i + 1)));
      }
    }
    throw new ConsolidationCallError(error, {
      calls,
      retries: calls - 1,
      durationMs: Date.now() - started,
      tokenUsage: usage,
    });
  } finally {
    await client.close();
  }
}
