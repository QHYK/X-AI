import assert from 'node:assert/strict';
import { stage3MaxRetries, waitForStage3Retry } from '../src/processing/stage3-http-retry.js';

const waits: number[] = [];
const wait = async (milliseconds: number) => {
  waits.push(milliseconds);
};
const response = (status: number, retryAfter?: string) => ({
  cause: {
    status,
    headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
    error: { message: 'server_is_overloaded' },
  },
});
async function mockRequest(results: Array<'success' | unknown>) {
  let calls = 0;
  for (let attempt = 1; attempt <= stage3MaxRetries(2) + 1; attempt += 1) {
    calls += 1;
    const result = results[attempt - 1];
    if (result === 'success') return { success: true, calls };
    if (!(await waitForStage3Retry(result, attempt, stage3MaxRetries(2), 1_000, wait)))
      return { success: false, calls };
  }
  throw new Error('Unreachable');
}

const priorWarn = console.warn;
const warnings: string[] = [];
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '));
};
try {
  assert.deepEqual(await mockRequest([response(503, '47'), 'success']), {
    success: true,
    calls: 2,
  });
  assert.deepEqual(waits.splice(0), [60_000]);
  assert.deepEqual(await mockRequest([response(503), response(503), response(503)]), {
    success: false,
    calls: 3,
  });
  assert.deepEqual(waits.splice(0), [60_000, 60_000]);
  assert.deepEqual(await mockRequest([response(503, '75'), 'success']), {
    success: true,
    calls: 2,
  });
  assert.deepEqual(waits.splice(0), [75_000]);
  assert.deepEqual(await mockRequest([response(429), 'success']), { success: true, calls: 2 });
  assert.deepEqual(waits.splice(0), [1_000], 'Other HTTP errors retain the existing delay');
  assert.equal(stage3MaxRetries(9), 2);
  assert.ok(
    warnings.some((line) => line.includes('"status":503') && line.includes('"final_failure":true')),
  );
  assert.ok(warnings.every((line) => !line.includes('Authorization') && !line.includes('api_key')));
} finally {
  console.warn = priorWarn;
}
console.log(
  'PASS Stage3 HTTP 503 bounded retry, Retry-After, ordinary errors and redacted diagnostics',
);
