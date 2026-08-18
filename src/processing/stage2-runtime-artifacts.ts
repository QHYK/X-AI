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
  const outputPath = result.success ? join(runDir, "output.json") : null;
  const runPath = join(runDir, "run.json");
  const stage2aDir = join(runDir, "stage2a");
  const stage2bDir = join(runDir, "stage2b");
  const summary = summarizeStage2Result(result);

  await mkdir(stage2aDir, { recursive: true });
  await writeJson(inputPath, result.input);
  await writeJson(idMapPath, result.idMap);

  for (const batch of result.localBatches) {
    const batchName = `batch-${String(batch.batchIndex).padStart(3, "0")}`;
    await writeJson(join(stage2aDir, `${batchName}-input.json`), batch.input);
    if (batch.output) {
      await writeJson(join(stage2aDir, `${batchName}-output.json`), batch.output);
    }
  }

  if (result.reconciliationInput) {
    await mkdir(stage2bDir, { recursive: true });
    await writeJson(join(stage2bDir, "input.json"), result.reconciliationInput);
  }
  if (result.reconciliationOutput) {
    await writeJson(join(stage2bDir, "output.json"), result.reconciliationOutput);
  }

  if (result.success) {
    await writeJson(join(runDir, "output.json"), result.output);
  }

  await writeJson(runPath, {
    stage: "stage2",
    started_at: options.startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    model: result.model,
    prompt_version: result.promptVersion,
    reconciliation_prompt_version: result.reconciliationPromptVersion,
    candidate_count: summary.eventCandidateCount,
    stage2a_batch_count: summary.stage2aBatchCount,
    stage2a_batch_candidate_counts: summary.stage2aBatchCandidateCounts,
    preliminary_group_count: summary.preliminaryGroupCount,
    stage2b_input_group_count: summary.stage2bInputGroupCount,
    stage2b_group_count: summary.eventGroupCount,
    final_group_count: summary.eventGroupCount,
    multi_source_group_count: summary.multiSourceGroupCount,
    single_source_group_count: summary.singleSourceGroupCount,
    cross_batch_merge_count: summary.crossBatchMergeCount,
    cross_category_merge_count: summary.crossCategoryMergeCount,
    llm_calls: summary.llmCallCount,
    llm_duration_ms: summary.llmDurationMs,
    retry_count: summary.retryCount,
    total_duration_ms: result.elapsedMs,
    assignment_missing_count: summary.missingTempIds.length,
    assignment_duplicate_count: summary.duplicateTempIds.length,
    assignment_invented_count: summary.inventedTempIds.length,
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
