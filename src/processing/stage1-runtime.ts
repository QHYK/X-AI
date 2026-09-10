/** Stage 1 runtime artifact 的最小读取器，供下游 Stage 建立本次执行 lineage。 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Stage1RuntimeRun = {
  stage?: string;
  status?: string;
  daily_date?: string | null;
  started_at?: string;
  finished_at?: string;
  scope_start_at?: string | null;
  scope_end_at?: string | null;
};

export type LoadedStage1Runtime = {
  runDir: string;
  run: Required<Pick<Stage1RuntimeRun, "started_at" | "finished_at">> & Stage1RuntimeRun;
};

/** 读取指定 run，或回退到最近一次完整且成功的 Stage 1 runtime。 */
export async function loadStage1Runtime(
  rootDir: string,
  stage1RunDirOption?: string,
  dailyDate?: string,
): Promise<LoadedStage1Runtime> {
  const runDir = stage1RunDirOption
    ? normalizeRuntimePath(rootDir, stage1RunDirOption)
    : await findLatestSuccessfulStage1RunDir(rootDir, dailyDate);
  const run = await readJson<Stage1RuntimeRun>(join(runDir, "run.json"));

  if (run.status !== "success") {
    throw new Error(`Stage 1 runtime directory is not successful: ${runDir}`);
  }
  if (!isTimestamp(run.started_at) || !isTimestamp(run.finished_at)) {
    throw new Error(`Stage 1 runtime is missing valid execution timestamps: ${runDir}`);
  }

  return {
    runDir,
    run: run as LoadedStage1Runtime["run"],
  };
}

async function findLatestSuccessfulStage1RunDir(
  rootDir: string,
  dailyDate?: string,
): Promise<string> {
  const root = join(rootDir, "runtime/stage1");
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    try {
      const run = await readJson<Stage1RuntimeRun>(join(candidate, "run.json"));
      if (
        run.status === "success" &&
        isTimestamp(run.started_at) &&
        isTimestamp(run.finished_at) &&
        (!dailyDate || run.daily_date === dailyDate)
      ) {
        return candidate;
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }

  throw new Error(
    `No successful Stage 1 runtime run${dailyDate ? ` for ${dailyDate}` : ""} found under ${root}.`,
  );
}

function normalizeRuntimePath(rootDir: string, value: string): string {
  return value.startsWith("/") ? value : join(rootDir, value);
}

function isTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((value) => JSON.parse(value) as T);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
