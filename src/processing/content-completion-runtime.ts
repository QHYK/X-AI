import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ContentCompletionRuntimeArtifact = {
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  candidate_count: number | null;
  selected_count: number | null;
  success_count: number | null;
  failed_count: number | null;
  skipped_count: number | null;
  remaining_count: number | null;
  limit: number;
  per_source_limit: number;
  error: string | null;
};

export function contentCompletionRunDir(
  startedAt: Date,
  rootDir: string = process.cwd(),
): string {
  return join(
    rootDir,
    "runtime/content-completion",
    startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
}

export async function writeContentCompletionRuntime(
  runDir: string,
  artifact: ContentCompletionRuntimeArtifact,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`);
}
