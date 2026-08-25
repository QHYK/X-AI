/**
 * Daily 编排脚本与各独立命令之间的环境变量契约。
 *
 * 除传递固定 scope 外，也把本次 Stage 2/3 runtime 路径固定为下游 lineage。
 */
import { toDailyScopeEnv, type DailyScope } from "./daily-scope.js";

export type DailyStageName =
  | "collect:rss"
  | "complete:content"
  | "process:stage1"
  | "process:stage2"
  | "process:stage3"
  | "process:stage4";

export type DailyLineage = {
  stage2Run: string | null;
  stage3Run: string | null;
};

/** 为单个 Daily 步骤生成 scope 与上游 runtime lineage 的环境变量。 */
export function buildDailyStepEnv(options: {
  scope: DailyScope;
  step: DailyStageName;
  lineage: DailyLineage;
  runPointerPath?: string;
}): Record<string, string> {
  const env = toDailyScopeEnv(options.scope);

  if (options.runPointerPath) {
    env.DAILY_STAGE_RUN_POINTER = options.runPointerPath;
  }
  if (options.step === "process:stage3") {
    if (!options.lineage.stage2Run) {
      throw new Error("Stage 3 requires the current Daily Stage 2 run path.");
    }
    env.STAGE3_STAGE2_RUN_DIR = options.lineage.stage2Run;
  }
  if (options.step === "process:stage4") {
    if (!options.lineage.stage3Run) {
      throw new Error("Stage 4 requires the current Daily Stage 3 run path.");
    }
    env.STAGE4_STAGE3_RUN_DIR = options.lineage.stage3Run;
  }

  return env;
}
