import { PromptMemory } from './fixtures/prompt-runtime.js';
import { withPromptBindings, databasePromptBinder } from '../src/lib/prompts/runtime.js';
import { strict as assert } from 'node:assert';

// These values must be present before the dynamic import because Stage 2 reads
// its retry defaults during module initialization, just as process-stage2 does
// after it loads .env.local.
process.env.STAGE2_LLM_MAX_RETRIES = '2';
process.env.STAGE2_LLM_RETRY_DELAY_MS = '0';

const { runStage2MergeLlm: executeStage2 } = await import('../src/processing/stage2-llm.js');

const prompts = new PromptMemory();
const runStage2MergeLlm = (...args: Parameters<typeof executeStage2>) =>
  withPromptBindings(prompts.db, databasePromptBinder(prompts.db, 'discovery', 'stage2-test'), () =>
    executeStage2(...args),
  );

const input = { event_candidates: [{ temp_id: 'E001', title: 'Fixture' }] } as never;
const successfulResponse = {
  id: 'response-1',
  output_text: JSON.stringify({ events: [{ event_hint: 'Fixture', sources: ['E001'] }] }),
  output: [],
  api_mode: 'responses' as const,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  finish_reason: 'stop',
};

let calls = 0;
const success = await runStage2MergeLlm(input, {
  request: async () => {
    calls += 1;
    return successfulResponse;
  },
});
assert.equal(success.success, true);
assert.equal(calls, 1);
assert.equal(success.attempts, 1);
assert.equal(success.attemptLog.length, 1);

calls = 0;
const recovered = await runStage2MergeLlm(input, {
  request: async () => {
    calls += 1;
    if (calls === 1)
      throw diagnosticError(408, 'stream_disconnected', 'stream disconnected before completion');
    return successfulResponse;
  },
});
assert.equal(recovered.success, true);
assert.equal(calls, 2);
assert.equal(recovered.attempts, 2);
assert.equal(recovered.attemptLog[0]?.statusCode, 408);
assert.equal(recovered.attemptLog[0]?.errorType, 'stream_disconnected');

calls = 0;
const exhausted = await runStage2MergeLlm(input, {
  request: async () => {
    calls += 1;
    throw diagnosticError(408, 'timeout', 'proxy timeout');
  },
});
assert.equal(exhausted.success, false);
assert.equal(calls, 3);
assert.equal(exhausted.attempts, 3);
assert.match(exhausted.error, /Attempts: 3, Retries: 2/);
assert.equal(exhausted.attemptLog.length, 3);

calls = 0;
const unauthorized = await runStage2MergeLlm(input, {
  request: async () => {
    calls += 1;
    throw diagnosticError(401, 'invalid_api_key', 'Incorrect API key');
  },
});
assert.equal(unauthorized.success, false);
assert.equal(calls, 1);
assert.match(unauthorized.error, /Attempts: 1, Retries: 0/);

console.log(
  'Stage 2 retry configuration, transient 408 retry, attempt diagnostics, and auth short-circuit tests passed',
);

function diagnosticError(status: number, type: string, message: string): Error {
  return new Error(
    `LLM HTTP request failed: ${JSON.stringify({ response: { status, code: null, type, message } })}`,
  );
}