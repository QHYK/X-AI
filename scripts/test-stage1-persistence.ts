import { persistStage1BatchSequentially } from "../src/processing/stage1-job.js";

let activePersistence = 0;
let maxActivePersistence = 0;
const completionOrder: number[] = [];

const results = await persistStage1BatchSequentially([1, 2, 3, 4, 5, 6, 7, 8], async (item) => {
  activePersistence += 1;
  maxActivePersistence = Math.max(maxActivePersistence, activePersistence);
  await new Promise((resolve) => setImmediate(resolve));
  completionOrder.push(item);
  activePersistence -= 1;
  return item * 10;
});

const passed =
  maxActivePersistence === 1 &&
  JSON.stringify(completionOrder) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]) &&
  JSON.stringify(results) === JSON.stringify([10, 20, 30, 40, 50, 60, 70, 80]);

console.log(`${passed ? "PASS" : "FAIL"} Stage 1 persists one successful batch sequentially`);
if (!passed) {
  console.error({ maxActivePersistence, completionOrder, results });
  process.exitCode = 1;
}
