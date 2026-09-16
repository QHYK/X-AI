import {
  nextDisplayRankForAiRankUpdate,
  nextDisplayRankForStaleClear,
} from "../src/processing/stage3-persistence.js";
import {
  normalizeStage3EventRankingOutput,
  normalizeStage3RankingOutput,
} from "../src/processing/stage3-contract.js";
import { canReuseStage3Ranking, stage3WarningMetrics } from "../src/processing/stage3-job.js";

type TestCase = {
  name: string;
  actual: number | null;
  expected: number | null;
};

const cases: TestCase[] = [
  {
    name: "Case A: old ai null, old display null, new rank 3 sets display 3",
    actual: nextDisplayRankForAiRankUpdate(null, null, 3),
    expected: 3,
  },
  {
    name: "Case B: old display synced with old ai updates to new rank",
    actual: nextDisplayRankForAiRankUpdate(5, 5, 2),
    expected: 2,
  },
  {
    name: "Case C: old display differs from old ai is preserved",
    actual: nextDisplayRankForAiRankUpdate(5, 1, 2),
    expected: 1,
  },
  {
    name: "Case D: stale synced display is cleared",
    actual: nextDisplayRankForStaleClear(5, 5),
    expected: null,
  },
  {
    name: "Case E: stale human override display is preserved",
    actual: nextDisplayRankForStaleClear(5, 1),
    expected: 1,
  },
];

const failures = cases.filter((testCase) => testCase.actual !== testCase.expected);
const expectedIds = ["L001", "L002", "L003"];
const duplicateAndMissing = normalizeStage3RankingOutput({ rankings: [
  { id: "L002", rank: 1, reason: "first" },
  { id: "L002", rank: 2, reason: "duplicate" },
  { id: "L001", rank: 4, reason: "kept" },
] }, expectedIds);
const invented = normalizeStage3RankingOutput({ rankings: [{ id: "unknown", rank: 1, reason: "bad" }] }, expectedIds);
const event = normalizeStage3EventRankingOutput({ ordered_ids: ["E002", "E002"] }, ["E001", "E002"]);
const rankingChecks = [
  !invented.success,
  event.success && JSON.stringify(event.output.ordered_ids) === JSON.stringify(["E002", "E001"]),
  JSON.stringify(stage3WarningMetrics({ warningCount: 3, duplicateRankingCount: 1, missingRankingCount: 1 })) === JSON.stringify({ warning_count: 3, duplicate_ranking_count: 1, missing_ranking_count: 1 }),
  canReuseStage3Ranking("same-input", "same-input", "success"),
  canReuseStage3Ranking("same-input", "same-input", "skipped"),
  !canReuseStage3Ranking("new-stage2-input", "old-stage2-input", "success"),
  !canReuseStage3Ranking("same-input", "same-input", "failed"),
];
if (!(duplicateAndMissing.success && JSON.stringify(duplicateAndMissing.output.rankings.map((item) => item.id)) === JSON.stringify(["L002", "L001", "L003"]) && duplicateAndMissing.output.rankings.every((item, index) => item.rank === index + 1))) {
  failures.push({ name: "Ranking normalization keeps first duplicate, appends missing, and reindexes", actual: 0, expected: 1 });
}
if (rankingChecks.some((passed) => !passed)) {
  failures.push({ name: "Ranking warning/fatal policy", actual: 0, expected: 1 });
}
if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        success: false,
        failures,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        success: true,
        passed: cases.length + rankingChecks.length + 1,
      },
      null,
      2,
    ),
  );
}
