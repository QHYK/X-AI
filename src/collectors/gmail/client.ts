import type { OAuth2Client } from 'google-auth-library';
export const DEFAULT_QUERY = 'label:news-letter';

export function errorType(error: unknown) {
  const response = (
    error as {
      response?: { status?: number; data?: { error?: { details?: { reason?: string }[] } } };
    }
  )?.response;
  const code = response?.status;
  const reason = response?.data?.error?.details?.find((d) =>
    ['SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(d.reason ?? ''),
  )?.reason;
  if (code && reason) return `gmail_http_${code}_${reason.toLowerCase()}`;
  return typeof code === 'number'
    ? `gmail_http_${code}`
    : error instanceof Error &&
        /^(oauth_|gmail_|query_|limit_|sample_)[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'operation_failed';
}

export async function retry<T>(
  operation: () => Promise<T>,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const response = (
        error as {
          response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
        }
      )?.response;
      const limited =
        response?.status === 403 &&
        response.data?.error?.errors?.some((e) =>
          ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason ?? ''),
        );
      const networkFailure = ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(
        String((error as { code?: string })?.code ?? ''),
      );
      if (
        attempt >= 2 ||
        !(response?.status === 429 || (response?.status ?? 0) >= 500 || limited || networkFailure)
      )
        throw error;
      await wait(500 * 2 ** attempt);
    }
  }
}

export type GmailReader = {
  list: (
    query: string,
    pageToken: string | undefined,
    maxResults: number,
  ) => Promise<{ messages?: { id?: string }[]; nextPageToken?: string }>;
  get: (id: string, format?: 'full' | 'metadata') => Promise<unknown>;
  labels?: () => Promise<{ id: string; name: string }[]>;
};

export function gmailReader(auth: OAuth2Client): GmailReader {
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
  return {
    list: async (q, pageToken, maxResults) =>
      (
        await retry(() =>
          auth.request<Awaited<ReturnType<GmailReader['list']>>>({
            url: base,
            method: 'GET',
            params: { q, pageToken, maxResults },
            timeout: 30_000,
            retry: false,
          }),
        )
      ).data,
    labels: async () =>
      (
        await retry(() =>
          auth.request<{ labels?: { id: string; name: string }[] }>({
            url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
            method: 'GET',
            timeout: 30_000,
            retry: false,
          }),
        )
      ).data.labels ?? [],
    get: async (id, format = 'full') =>
      (
        await retry(() =>
          auth.request({
            url: `${base}/${encodeURIComponent(id)}`,
            method: 'GET',
            params: { format },
            timeout: 30_000,
            retry: false,
          }),
        )
      ).data,
  };
}

export function validateSelection(query: string, limit: number) {
  if (!query.trim() || /^(?:in:anywhere|in:all|\*)$/i.test(query.trim()))
    throw new Error('query_filter_required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('limit_must_be_1_to_200');
}
