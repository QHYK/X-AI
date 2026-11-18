/** Stage 3 uses its own bounded request loop; the OpenAI SDK is configured with maxRetries: 0. */
export type Stage3Wait = (milliseconds: number) => Promise<void>;

export const stage3MaxRetries = (configured: number) => Math.max(0, Math.min(2, configured));

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function responseStatus(error: unknown): { status: number | null; retryAfter: string | null } {
  let value: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const item = record(value);
    if (!item) break;
    const response = record(item.response);
    const status = typeof item.status === 'number' ? item.status : response?.status;
    if (typeof status === 'number') {
      const headers = item.headers ?? response?.headers;
      const headerObject = record(headers);
      const get = headerObject?.get;
      const header =
        typeof get === 'function'
          ? (get as (name: string) => unknown).call(headers, 'retry-after')
          : (headerObject?.['retry-after'] ?? headerObject?.['Retry-After']);
      return { status, retryAfter: typeof header === 'string' ? header : null };
    }
    value = item.cause;
  }
  return { status: null, retryAfter: null };
}

function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

/** Returns whether the caller should retry this failed request. */
export async function waitForStage3Retry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  ordinaryDelayMs: number,
  wait: Stage3Wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  const { status, retryAfter } = responseStatus(error);
  const retry = attempt <= maxRetries;
  if (status === 503) {
    const waitMs = retry ? Math.max(60_000, retryAfterMs(retryAfter)) : 0;
    const startedWaiting = Date.now();
    if (retry) await wait(waitMs);
    console.warn(
      '[stage3] LLM HTTP retry',
      JSON.stringify({
        status,
        retry_count: retry ? attempt : attempt - 1,
        wait_ms: waitMs,
        elapsed_wait_ms: retry ? Date.now() - startedWaiting : 0,
        final_failure: !retry,
        final_reason: retry ? null : 'HTTP 503 retry limit reached',
      }),
    );
    return retry;
  }
  if (retry) await wait(ordinaryDelayMs * attempt);
  return retry;
}
