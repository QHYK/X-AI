import type { Pool } from "pg";
import {
  readCollectedAtScopeFromEnv,
  resolveDailyScope,
} from "../src/lib/daily-scope.js";
import { buildDailyStepEnv } from "../src/lib/daily-workflow.js";
import { loadPendingStage1Articles } from "../src/processing/stage1-job.js";
import { loadStage2EventCandidates } from "../src/processing/stage2-candidates.js";
import { loadStage3RankingRows } from "../src/processing/stage3-job.js";

type CapturedQuery = {
  text: string;
  values: unknown[] | undefined;
};

type Check = {
  name: string;
  passed: boolean;
  detail?: unknown;
};

const checks: Check[] = [];
const executionTimes = [
  "2026-08-25T01:00:00.000Z",
  "2026-08-25T06:00:00.000Z",
  "2026-08-25T14:00:00.000Z",
];
const scopes = executionTimes.map((time) =>
  resolveDailyScope("2026-08-25", new Date(time)),
);
const expectedScope = {
  dailyDate: "2026-08-25",
  timezone: "Asia/Shanghai",
  startAt: "2026-08-24T01:00:00.000Z",
  endAt: "2026-08-25T01:00:00.000Z",
};

checks.push({
  name: "same DAILY_DATE is deterministic at 09:00, 14:00, and 22:00 Shanghai",
  passed: scopes.every((scope) => JSON.stringify(scope) === JSON.stringify(expectedScope)),
  detail: scopes,
});
checks.push({
  name: "default scope uses the latest ended Shanghai 09:00 boundary",
  passed:
    resolveDailyScope(undefined, new Date("2026-08-25T00:59:59.999Z")).dailyDate ===
      "2026-08-24" &&
    resolveDailyScope(undefined, new Date("2026-08-25T01:00:00.000Z")).dailyDate ===
      "2026-08-25" &&
    resolveDailyScope(undefined, new Date("2026-08-25T22:00:00.000Z")).dailyDate ===
      "2026-08-25",
});

const scope = scopes[0];
const envScope = readCollectedAtScopeFromEnv({
  DAILY_SCOPE_START_AT: scope.startAt,
  DAILY_SCOPE_END_AT: scope.endAt,
});
checks.push({
  name: "Daily scope environment preserves the exact half-open boundaries",
  passed:
    envScope?.startAt === expectedScope.startAt && envScope.endAt === expectedScope.endAt,
  detail: envScope,
});

const scopedQueries: CapturedQuery[] = [];
const scopedQueryable = createCapturingQueryable(scopedQueries);
await loadPendingStage1Articles(scopedQueryable, { collectedAtScope: scope });
await loadStage2EventCandidates(scopedQueryable, { collectedAtScope: scope });
await loadStage3RankingRows(scopedQueryable, "digest", 24, scope);

checks.push({
  name: "Stage 1, 2, and 3 use the same [scope_start, scope_end) values",
  passed:
    scopedQueries.length === 3 &&
    scopedQueries.every((query) =>
      query.text.includes("ra.collected_at >=") && query.text.includes("ra.collected_at <"),
    ) &&
    JSON.stringify(scopedQueries[0]?.values) ===
      JSON.stringify([expectedScope.startAt, expectedScope.endAt]) &&
    JSON.stringify(scopedQueries[1]?.values) ===
      JSON.stringify([expectedScope.startAt, expectedScope.endAt]) &&
    JSON.stringify(scopedQueries[2]?.values?.slice(1)) ===
      JSON.stringify([expectedScope.startAt, expectedScope.endAt]),
  detail: scopedQueries,
});

const defaultQueries: CapturedQuery[] = [];
const defaultQueryable = createCapturingQueryable(defaultQueries);
await loadPendingStage1Articles(defaultQueryable);
await loadStage2EventCandidates(defaultQueryable);
await loadStage3RankingRows(defaultQueryable, "long_form", 24);
checks.push({
  name: "standalone Stage 1, 2, and 3 keep their rolling 24-hour defaults",
  passed:
    defaultQueries.length === 3 &&
    defaultQueries.every((query) => query.text.includes("now() -")) &&
    JSON.stringify(defaultQueries[0]?.values) === JSON.stringify([24]) &&
    JSON.stringify(defaultQueries[1]?.values) === JSON.stringify([24]) &&
    JSON.stringify(defaultQueries[2]?.values) === JSON.stringify(["long_form", 24]),
  detail: defaultQueries,
});

const stage3Env = buildDailyStepEnv({
  scope,
  step: "process:stage3",
  lineage: { stage2Run: "runtime/stage2/current", stage3Run: null },
});
const stage4Env = buildDailyStepEnv({
  scope,
  step: "process:stage4",
  lineage: {
    stage2Run: "runtime/stage2/current",
    stage3Run: "runtime/stage3/current",
  },
});
checks.push({
  name: "Stage 3 and Stage 4 receive the current Daily runtime lineage",
  passed:
    stage3Env.STAGE3_STAGE2_RUN_DIR === "runtime/stage2/current" &&
    stage4Env.STAGE4_STAGE3_RUN_DIR === "runtime/stage3/current",
  detail: { stage3Env, stage4Env },
});

const failures = checks.filter((check) => !check.passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

function createCapturingQueryable(queries: CapturedQuery[]): Pick<Pool, "query"> {
  return {
    query: (async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [] };
    }) as Pick<Pool, "query">["query"],
  };
}
