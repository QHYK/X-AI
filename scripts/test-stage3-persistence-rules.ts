import {
  nextDisplayRankForAiRankUpdate,
  nextDisplayRankForStaleClear,
} from "../src/processing/stage3-persistence.js";

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
        passed: cases.length,
      },
      null,
      2,
    ),
  );
}
