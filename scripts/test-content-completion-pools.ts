import { strict as assert } from "node:assert";
import type { Pool } from "pg";
import {
  completeRawArticleContent,
  resolveContentCompletionLimits,
  splitCompletionCandidates,
} from "../src/processing/content-completion.js";

for (const [count, expectedA, expectedB] of [[40, 20, 20], [79, 40, 39], [80, 40, 40], [120, 40, 40]] as const) {
  const assignments = splitCompletionCandidates(Array.from({ length: count }, (_, index) => index));
  assert.equal(assignments.A.length, expectedA);
  assert.equal(assignments.B.length, expectedB);
}
assert.equal(resolveContentCompletionLimits({ limit: 120 }).limit, 80);

const savedFetch = globalThis.fetch;
const savedKeyA = process.env.FIRECRAWL_API_KEY;
const savedKeyB = process.env.FIRECRAWL_API_KEY_2;
try {
  process.env.FIRECRAWL_API_KEY = "pool-a-key";
  process.env.FIRECRAWL_API_KEY_2 = "pool-b-key";
  const headers: string[] = [];
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = (async (_url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    headers.push(new Headers(init?.headers).get("Authorization") ?? "");
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(JSON.stringify({ success: true, markdown: "# Article\n\n".padEnd(200, "x") }), { status: 200 });
  }) as typeof fetch;

  const summary = await completeRawArticleContent(createPool([candidate("a"), candidate("b")]), { limit: 2, concurrency: 1 });
  assert.deepEqual(summary.results.map((result) => result.pool), ["A", "B"]);
  assert.deepEqual(headers, ["Bearer pool-a-key", "Bearer pool-b-key"]);
  assert.equal(maxActive, 2);
  assert.equal(summary.poolMetrics.A.assignedCount, 1);
  assert.equal(summary.poolMetrics.B.assignedCount, 1);

  delete process.env.FIRECRAWL_API_KEY_2;
  let unexpectedRequests = 0;
  globalThis.fetch = (async () => { unexpectedRequests += 1; throw new Error("unexpected request"); }) as typeof fetch;
  await assert.rejects(
    () => completeRawArticleContent(createPool([candidate("missing-key")]), { limit: 1 }),
    /FIRECRAWL_API_KEY_2 is required/,
  );
  assert.equal(unexpectedRequests, 0);
} finally {
  globalThis.fetch = savedFetch;
  if (savedKeyA === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = savedKeyA;
  if (savedKeyB === undefined) delete process.env.FIRECRAWL_API_KEY_2;
  else process.env.FIRECRAWL_API_KEY_2 = savedKeyB;
}

console.log("Content Completion fixed A/B split, pool key isolation, parallel workers, and missing-key safety tests passed");

function candidate(id: string) {
  return { id, sourceName: "Fixture", title: id, url: `https://example.test/${id}`, contentText: null };
}

function createPool(candidates: ReturnType<typeof candidate>[]): Pool {
  let countCalls = 0;
  return {
    query: async (text: string) => {
      if (text.includes("select count(*)::int")) {
        countCalls += 1;
        return { rows: [{ count: countCalls === 1 ? candidates.length : 0 }] };
      }
      if (text.includes("with ranked as")) return { rows: candidates };
      if (text.includes("update raw_articles")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    },
  } as never;
}
