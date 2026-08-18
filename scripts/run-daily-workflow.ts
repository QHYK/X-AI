import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STEPS = [
  "collect:rss",
  "complete:content",
  "process:stage1",
  "process:stage2",
  "process:stage3",
  "process:stage4",
] as const;

type StepName = (typeof STEPS)[number];
type StepStatus = "running" | "success" | "failed";

type StepRun = {
  name: StepName;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: StepStatus;
  exit_code: number | null;
};

type DailyRun = {
  started_at: string;
  finished_at: string | null;
  status: StepStatus;
  duration_ms: number | null;
  steps: StepRun[];
  failed_step: StepName | null;
};

async function main() {
  const startedAt = new Date();
  const runDir = join(process.cwd(), "runtime/daily", toRunTimestamp(startedAt));
  const runPath = join(runDir, "run.json");
  const run: DailyRun = {
    started_at: startedAt.toISOString(),
    finished_at: null,
    status: "running",
    duration_ms: null,
    steps: [],
    failed_step: null,
  };

  await mkdir(runDir, { recursive: true });
  await writeRun(runPath, run);
  console.log(`[daily] Runtime artifact: ${runPath}`);

  for (const name of STEPS) {
    const stepStartedAt = new Date();
    const step: StepRun = {
      name,
      started_at: stepStartedAt.toISOString(),
      finished_at: null,
      duration_ms: null,
      status: "running",
      exit_code: null,
    };
    run.steps.push(step);
    await writeRun(runPath, run);

    console.log(`\n[daily] Starting ${name}`);
    const exitCode = await runNpmScript(name);
    const stepFinishedAt = new Date();
    step.finished_at = stepFinishedAt.toISOString();
    step.duration_ms = stepFinishedAt.getTime() - stepStartedAt.getTime();
    step.exit_code = exitCode;
    step.status = exitCode === 0 ? "success" : "failed";

    console.log(`[daily] ${name} ${step.status} (exit ${exitCode}, ${step.duration_ms} ms)`);

    if (exitCode !== 0) {
      finishRun(run, startedAt, stepFinishedAt, "failed", name);
      await writeRun(runPath, run);
      process.exitCode = exitCode;
      return;
    }

    await writeRun(runPath, run);
  }

  const finishedAt = new Date();
  finishRun(run, startedAt, finishedAt, "success", null);
  await writeRun(runPath, run);
  console.log(`\n[daily] Workflow success (${run.duration_ms} ms)`);
}

function runNpmScript(name: StepName): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", name], {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", (error) => {
      console.error(`[daily] Failed to start ${name}.`, error);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      console.error(`[daily] ${name} terminated by signal ${signal ?? "unknown"}.`);
      resolve(1);
    });
  });
}

function finishRun(
  run: DailyRun,
  startedAt: Date,
  finishedAt: Date,
  status: "success" | "failed",
  failedStep: StepName | null,
) {
  run.finished_at = finishedAt.toISOString();
  run.status = status;
  run.duration_ms = finishedAt.getTime() - startedAt.getTime();
  run.failed_step = failedStep;
}

function writeRun(path: string, run: DailyRun): Promise<void> {
  return writeFile(path, `${JSON.stringify(run, null, 2)}\n`);
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

main().catch((error) => {
  console.error("[daily] Workflow failed.", error);
  process.exitCode = 1;
});
