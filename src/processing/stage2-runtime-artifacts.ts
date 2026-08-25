/**
 * Stage 2 runtime artifact 写入层。
 * 保存模型输入、id-map、输出与统计，作为 Stage 3 的明确上游 lineage。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeStage2Result, type Stage2JobResult } from "./stage2-job.js";

export type Stage2RuntimeArtifact = {
  runDir: string;
  inputPath: string;
  idMapPath: string;
  outputPath: string | null;
  runPath: string;
};

/** 将一次 Stage 2 结果落为独立 run 目录，即使失败也保留可排障的输入和运行摘要。 */
export async function writeStage2RuntimeArtifacts(
  result: Stage2JobResult,
  options: {
    startedAt: Date;
    finishedAt?: Date;
    rootDir?: string;
  },
): Promise<Stage2RuntimeArtifact> {
  const finishedAt = options.finishedAt ?? new Date();
  const runDir = join(
    options.rootDir ?? "runtime/stage2",
    toRunTimestamp(options.startedAt),
  );
  const inputPath = join(runDir, "input.json");
  const idMapPath = join(runDir, "id-map.json");
  const outputPath = result.output ? join(runDir, "output.json") : null;
  const runPath = join(runDir, "run.json");
  const summary = summarizeStage2Result(result);

  await mkdir(runDir, { recursive: true });
  await writeJson(inputPath, result.input);
  await writeJson(idMapPath, result.idMap);

  if (result.output) {
    await writeJson(join(runDir, "output.json"), result.output);
  }

  await writeJson(runPath, {
    stage: "stage2",
    started_at: options.startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    model: result.model,
    prompt_version: result.promptVersion,
    candidate_count: summary.eventCandidateCount,
    final_group_count: summary.eventGroupCount,
    multi_source_group_count: summary.multiSourceGroupCount,
    single_source_group_count: summary.singleSourceGroupCount,
    llm_calls: summary.llmCallCount,
    llm_duration_ms: summary.llmDurationMs,
    retry_count: summary.retryCount,
    total_duration_ms: result.elapsedMs,
    input_tokens: result.tokenUsage?.inputTokens ?? null,
    output_tokens: result.tokenUsage?.outputTokens ?? null,
    total_tokens: result.tokenUsage?.totalTokens ?? null,
    finish_reason: result.finishReason,
    assignment_validation_passed: summary.assignmentValidationPassed,
    assignment_missing_count: summary.missingTempIds.length,
    assignment_duplicate_count: summary.duplicateTempIds.length,
    assignment_invented_count: summary.inventedTempIds.length,
    assignment_missing_ids: summary.missingTempIds,
    assignment_duplicate_ids: summary.duplicateTempIds,
    assignment_invented_ids: summary.inventedTempIds,
    status: result.success ? "success" : "failed",
    error: result.success ? null : result.error,
  });

  return {
    runDir,
    inputPath,
    idMapPath,
    outputPath,
    runPath,
  };
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
