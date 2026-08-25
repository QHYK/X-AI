/**
 * Dashboard 触发 Daily Workflow 的受限启动器。
 *
 * 只允许从项目根目录执行固定的 `npm run daily`；runtime 下的轻量锁用于避免
 * 多个 Dashboard 请求或服务进程同时启动同一条完整工作流。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_FILE_NAME = ".daily-workflow-retry.lock";

type DailyWorkflowLock = {
  run_id: string;
  pid: number;
  started_at: string;
};

export type DailyWorkflowRetryResult =
  | { status: "started" }
  | { status: "already_running" }
  | { status: "failed"; message: string };

type DailyWorkflowRetryOptions = {
  rootDir?: string;
  spawnDaily?: (cwd: string) => ChildProcess;
  isPidRunning?: (pid: number) => boolean;
};

/** 判断详情日期是否就是当前可重跑的默认 Daily 日期。 */
export function isCurrentDailyDate(detailDate: string, latestDailyDate: string): boolean {
  return detailDate === latestDailyDate;
}

/**
 * 在后台启动固定的 Daily 命令。
 *
 * 锁文件记录子进程 PID；服务重启后会检查该 PID，已经退出的残留锁会自动清除，
 * 因此不会永久阻塞后续重跑。
 */
export async function startDailyWorkflowRetry(
  options: DailyWorkflowRetryOptions = {},
): Promise<DailyWorkflowRetryResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const lockPath = join(rootDir, "runtime", "daily", LOCK_FILE_NAME);
  const runId = randomUUID();
  const isPidRunning = options.isPidRunning ?? defaultIsPidRunning;
  const acquired = await acquireLock(lockPath, { run_id: runId, pid: process.pid, started_at: new Date().toISOString() }, isPidRunning);

  if (!acquired) {
    return { status: "already_running" };
  }

  try {
    const child = (options.spawnDaily ?? spawnDailyWorkflow)(rootDir);
    const release = () => {
      void releaseLock(lockPath, runId);
    };
    // 先监听再写入子进程 PID，避免极短命令在监听器注册前退出而遗留锁。
    child.once("error", release);
    child.once("exit", release);
    await writeLock(lockPath, {
      run_id: runId,
      // child.pid may be unavailable only in mocked/error process objects; retain a valid owner then.
      pid: child.pid ?? process.pid,
      started_at: new Date().toISOString(),
    });
    child.unref();

    return { status: "started" };
  } catch (error) {
    await releaseLock(lockPath, runId);
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Failed to start Daily Workflow.",
    };
  }
}

/** 读取锁的实时状态，供 Dashboard 页面刷新后显示 Running 使用。 */
export async function isDailyWorkflowRunning(rootDir = process.cwd()): Promise<boolean> {
  const lockPath = join(rootDir, "runtime", "daily", LOCK_FILE_NAME);
  const lock = await readLock(lockPath);
  if (!lock) {
    return false;
  }
  if (defaultIsPidRunning(lock.pid)) {
    return true;
  }

  await releaseLock(lockPath, lock.run_id);
  return false;
}

function spawnDailyWorkflow(cwd: string): ChildProcess {
  return nodeSpawn("npm", ["run", "daily"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
}

async function acquireLock(
  lockPath: string,
  lock: DailyWorkflowLock,
  isPidRunning: (pid: number) => boolean,
): Promise<boolean> {
  await mkdir(join(lockPath, ".."), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(lock)}\n`);
      await handle.close();
      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const existing = await readLock(lockPath);
      if (existing && isPidRunning(existing.pid)) {
        return false;
      }

      // 已结束进程或损坏的旧锁不能阻止服务重启后的人工重跑。
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if (!isNotFoundError(unlinkError)) {
          throw unlinkError;
        }
      });
    }
  }

  return false;
}

function writeLock(lockPath: string, lock: DailyWorkflowLock): Promise<void> {
  return writeFile(lockPath, `${JSON.stringify(lock)}\n`);
}

async function releaseLock(lockPath: string, runId: string): Promise<void> {
  const lock = await readLock(lockPath);
  if (lock?.run_id !== runId) {
    return;
  }
  await unlink(lockPath).catch((error: unknown) => {
    if (!isNotFoundError(error)) {
      throw error;
    }
  });
}

async function readLock(lockPath: string): Promise<DailyWorkflowLock | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as DailyWorkflowLock).run_id !== "string" ||
      typeof (parsed as DailyWorkflowLock).pid !== "number"
    ) {
      return null;
    }
    return parsed as DailyWorkflowLock;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function defaultIsPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPERM";
}
