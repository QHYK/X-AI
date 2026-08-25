import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCurrentDailyDate,
  isDailyWorkflowRunning,
  startDailyWorkflowRetry,
} from "../src/lib/daily-workflow-retry.js";

class FakeChildProcess extends EventEmitter {
  constructor(readonly pid: number) {
    super();
  }

  unref(): this {
    return this;
  }
}

type Check = { name: string; passed: boolean };
const checks: Check[] = [];
const rootDir = await mkdtemp(join(tmpdir(), "x-ai-field-daily-retry-"));
const firstChild = new FakeChildProcess(41_001);
let spawnCount = 0;
const activePids = new Set<number>();
const commonOptions = {
  rootDir,
  isPidRunning: (pid: number) => activePids.has(pid),
};

try {
  const first = await startDailyWorkflowRetry({
    ...commonOptions,
    spawnDaily: () => {
      spawnCount += 1;
      activePids.add(firstChild.pid);
      return firstChild as never;
    },
  });
  checks.push({ name: "first retry request starts the fixed Daily workflow", passed: first.status === "started" && spawnCount === 1 });

  const second = await startDailyWorkflowRetry({
    ...commonOptions,
    spawnDaily: () => {
      spawnCount += 1;
      return new FakeChildProcess(41_002) as never;
    },
  });
  checks.push({ name: "an active workflow prevents a second spawn", passed: second.status === "already_running" && spawnCount === 1 });

  activePids.delete(firstChild.pid);
  firstChild.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  checks.push({ name: "child exit releases the running lock", passed: !(await isDailyWorkflowRunning(rootDir)) });

  const spawnFailure = await startDailyWorkflowRetry({
    ...commonOptions,
    spawnDaily: () => {
      throw new Error("mock spawn failure");
    },
  });
  const afterFailure = await startDailyWorkflowRetry({
    ...commonOptions,
    spawnDaily: () => new FakeChildProcess(41_003) as never,
  });
  checks.push({ name: "a spawn failure releases the lock for another attempt", passed: spawnFailure.status === "failed" && afterFailure.status === "started" });

  checks.push({
    name: "historical Date Details do not qualify for Retry Daily",
    passed: isCurrentDailyDate("2026-08-25", "2026-08-25") && !isCurrentDailyDate("2026-08-24", "2026-08-25"),
  });
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
if (failures.length > 0) {
  process.exitCode = 1;
}
