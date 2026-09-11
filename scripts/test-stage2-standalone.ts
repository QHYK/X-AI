import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptionalStage1Runtime } from "../src/processing/stage1-runtime.js";

const rootDir = await mkdtemp(join(tmpdir(), "x-ai-field-stage2-no-runtime-"));
try {
  const runtime = await loadOptionalStage1Runtime(rootDir, undefined, "2026-09-07");
  if (runtime !== null) throw new Error("Expected missing Stage 1 runtime to be optional.");
  console.log("Stage 2 standalone lineage test passed");
} finally {
  await rm(rootDir, { recursive: true, force: true });
}
