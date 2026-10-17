import assert from 'node:assert/strict';
import {
  cacheHitRate,
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  missingLlmTokenUsage,
  usageFromProvider,
} from '../src/processing/llm-token-usage.js';

const first = usageFromProvider({
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  cached_input_tokens: 40,
});
const zeroCache = usageFromProvider({
  input_tokens: 50,
  output_tokens: 10,
  total_tokens: 60,
  cached_input_tokens: 0,
});
const combined = mergeLlmTokenUsage(mergeLlmTokenUsage(emptyLlmTokenUsage(), first), zeroCache);

assert.deepEqual(combined, {
  inputTokens: 150,
  outputTokens: 30,
  totalTokens: 180,
  cachedInputTokens: 40,
  usageComplete: true,
});
assert.equal(cacheHitRate(combined), 40 / 150);

const missingCache = usageFromProvider({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
assert.equal(missingCache.cachedInputTokens, null);
assert.equal(missingCache.usageComplete, false);
const partial = mergeLlmTokenUsage(combined, missingLlmTokenUsage());
assert.equal(partial.inputTokens, 150);
assert.equal(partial.cachedInputTokens, null);
assert.equal(partial.usageComplete, false);
assert.equal(cacheHitRate(partial), null);

console.log('Daily LLM usage tests passed.');
