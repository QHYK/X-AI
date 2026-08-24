import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDailyScope } from "../src/lib/daily-scope.js";
import {
  buildDailyStepEnv,
  type DailyStageName,
} from "../src/lib/daily-workflow.js";

const STEPS = [
  "collect:rss",
  "complete:content",
  "process:stage1",
  "process:stage2",
  "process:stage3",
  "process:stage4",
] as const;

type StepName = (typeof STEPS)[number] & DailyStageName;
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
  daily_date: string;
  timezone: "Asia/Shanghai";
  scope_start_at: string;
  scope_end_at: string;
  content_completion_run: string | null;
  stage2_run: string | null;
  stage3_run: string | null;
  stage4_run: string | null;
  started_at: string;
  finished_at: string | null;
  status: StepStatus;
  duration_ms: number | null;
  steps: StepRun[];
  failed_step: StepName | null;
};

async function main() {
  const startedAt = new Date();
  const scope = resolveDailyScope(process.env.DAILY_DATE, startedAt);
  const runDir = join(process.cwd(), "runtime/daily", toRunTimestamp(startedAt));
  const runPath = join(runDir, "run.json");
  const run: DailyRun = {
    daily_date: scope.dailyDate,
    timezone: scope.timezone,
    scope_start_at: scope.startAt,
    scope_end_at: scope.endAt,
    content_completion_run: null,
    stage2_run: null,
    stage3_run: null,
    stage4_run: null,
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
  console.log(
    `[daily] Daily ${scope.dailyDate}: ${scope.startAt} <= collected_at < ${scope.endAt} (${scope.timezone})`,
  );

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
    const pointerPath = getRunPointerPath(runDir, name);
    const stepEnv = buildDailyStepEnv({
      scope,
      step: name,
      lineage: {
        stage2Run: run.stage2_run,
        stage3Run: run.stage3_run,
      },
      runPointerPath: pointerPath ?? undefined,
    });
    let exitCode = await runNpmScript(name, {
      ...process.env,
      ...stepEnv,
    });
    if (pointerPath) {
      try {
        setStageRun(run, name, (await readFile(pointerPath, "utf8")).trim());
      } catch (error) {
        if (exitCode === 0) {
          console.error(`[daily] ${name} did not report its runtime path.`, error);
          exitCode = 1;
        }
      }
    }
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

function runNpmScript(name: StepName, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", name], {
      env,
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

function getRunPointerPath(runDir: string, name: StepName): string | null {
  switch (name) {
    case "complete:content":
      return join(runDir, "content-completion-run.txt");
    case "process:stage2":
      return join(runDir, "stage2-run.txt");
    case "process:stage3":
      return join(runDir, "stage3-run.txt");
    case "process:stage4":
      return join(runDir, "stage4-run.txt");
    default:
      return null;
  }
}

function setStageRun(run: DailyRun, name: StepName, runDir: string): void {
  if (!runDir) {
    throw new Error(`${name} reported an empty runtime path.`);
  }

  switch (name) {
    case "complete:content":
      run.content_completion_run = runDir;
      break;
    case "process:stage2":
      run.stage2_run = runDir;
      break;
    case "process:stage3":
      run.stage3_run = runDir;
      break;
    case "process:stage4":
      run.stage4_run = runDir;
      break;
  }
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
