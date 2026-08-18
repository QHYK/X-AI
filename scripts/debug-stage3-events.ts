import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import {
  buildStage3EventRankingInput,
  loadStage2RunForStage3,
} from "../src/processing/stage3-job.js";
import { runStage3EventRankingLlm } from "../src/processing/stage3-event-ranking-llm.js";
import {
  assertStageLlmConfiguration,
  resolveStageLlmModel,
} from "../src/processing/llm-client.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type DebugRun = {
  started_at: string;
  finished_at: string | null;
  source_stage2_run_dir: string;
  event_group_count: number;
  candidate_mapping_count: number;
  missing_mapping_count: number;
  duplicate_mapping_count: number;
  input_bytes: number;
  total_event_hint_chars: number;
  total_source_title_chars: number;
  total_source_summary_chars: number;
  model: string;
  logical_llm_calls: number;
  llm_calls: number;
  retries: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  structured_output_valid: boolean;
  ordered_ids_count: number;
  ranking_integrity: {
    missing: string[];
    duplicate: string[];
    invented: string[];
  };
  top_10: Array<{
    id: string;
    rank: number;
    event_hint: string;
    source_count: number;
  }>;
  status: "running" | "success" | "failed";
  error: string | null;
};

async function main() {
  assertStageLlmConfiguration("stage3");

  const stage2RunDir = process.env.STAGE3_STAGE2_RUN_DIR;
  const stage2 = await loadStage2RunForStage3(process.cwd(), stage2RunDir);
  const eventBundle = buildStage3EventRankingInput(
    stage2.input,
    stage2.output,
    stage2.idMap,
  );
  validateEventRankingInput(eventBundle.input.events);

  const startedAt = new Date();
  const runDir = join(
    process.cwd(),
    "runtime/stage3-debug",
    toRunTimestamp(startedAt),
  );
  const inputPath = join(runDir, "events-input.json");
  const idMapPath = join(runDir, "id-map.json");
  const outputPath = join(runDir, "ordered-ids-output.json");
  const runPath = join(runDir, "run.json");
  await mkdir(runDir, { recursive: true });

  const inputText = `${JSON.stringify(eventBundle.input, null, 2)}\n`;
  await writeFile(inputPath, inputText);
  await writeJson(idMapPath, eventBundle.idMap);

  const model = resolveStageLlmModel("stage3");
  const run: DebugRun = {
    started_at: startedAt.toISOString(),
    finished_at: null,
    source_stage2_run_dir: stage2.runDir,
    event_group_count: eventBundle.input.events.length,
    candidate_mapping_count: Object.values(eventBundle.idMap).flat().length,
    missing_mapping_count: 0,
    duplicate_mapping_count: 0,
    input_bytes: Buffer.byteLength(inputText),
    total_event_hint_chars: eventBundle.input.events.reduce(
      (sum, event) => sum + event.event_hint.length,
      0,
    ),
    total_source_title_chars: eventBundle.input.events.reduce(
      (sum, event) =>
        sum + event.sources.reduce((sourceSum, source) => sourceSum + source.title.length, 0),
      0,
    ),
    total_source_summary_chars: eventBundle.input.events.reduce(
      (sum, event) =>
        sum +
        event.sources.reduce(
          (sourceSum, source) => sourceSum + source.summary.length,
          0,
        ),
      0,
    ),
    model,
    logical_llm_calls: 1,
    llm_calls: 0,
    retries: 0,
    duration_ms: 0,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    structured_output_valid: false,
    ordered_ids_count: 0,
    ranking_integrity: {
      missing: [],
      duplicate: [],
      invented: [],
    },
    top_10: [],
    status: "running",
    error: null,
  };
  await writeJson(runPath, run);

  const result = await runStage3EventRankingLlm(eventBundle.input, { model });
  run.llm_calls = result.attempts;
  run.retries = Math.max(0, result.attempts - 1);
  run.duration_ms = result.elapsedMs;
  run.input_tokens = result.tokenUsage?.inputTokens ?? null;
  run.output_tokens = result.tokenUsage?.outputTokens ?? null;
  run.total_tokens = result.tokenUsage?.totalTokens ?? null;
  run.structured_output_valid = result.success || result.assignment !== null;
  run.ordered_ids_count = result.success
    ? result.output.ordered_ids.length
    : result.rawOutputText
      ? safeOrderedIdsCount(result.rawOutputText)
      : 0;

  if (result.assignment) {
    run.ranking_integrity = {
      missing: result.assignment.missingIds,
      duplicate: result.assignment.duplicateIds,
      invented: result.assignment.inventedIds,
    };
  }

  if (result.success) {
    await writeJson(outputPath, result.output);
    const eventById = new Map(
      eventBundle.input.events.map((event) => [event.id, event]),
    );
    run.top_10 = [...result.rankings.rankings]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 10)
      .map((ranking) => {
        const event = eventById.get(ranking.id);
        if (!event) {
          throw new Error(`Ranking references unknown Event Group ${ranking.id}.`);
        }
        return {
          id: ranking.id,
          rank: ranking.rank,
          event_hint: event.event_hint,
          source_count: event.source_count,
        };
      });
    run.status = "success";
  } else {
    run.status = "failed";
    run.error = result.error;
  }

  run.finished_at = new Date().toISOString();
  await writeJson(runPath, run);
  console.log(JSON.stringify({ ...run, runtime_path: runDir }, null, 2));

  if (run.status === "failed") {
    process.exitCode = 1;
  }
}

function safeOrderedIdsCount(rawOutputText: string): number {
  try {
    const value = JSON.parse(rawOutputText) as { ordered_ids?: unknown };
    return Array.isArray(value.ordered_ids) ? value.ordered_ids.length : 0;
  } catch {
    return 0;
  }
}

function validateEventRankingInput(
  events: Array<{
    id: string;
    event_hint: string;
    source_count: number;
    sources: Array<{ source: string; title: string; summary: string }>;
  }>,
) {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event.id || !event.event_hint || event.sources.length === 0) {
      throw new Error(`Invalid Stage 3 Event Ranking input group ${event.id || "<missing>"}.`);
    }
    if (ids.has(event.id)) {
      throw new Error(`Duplicate Stage 3 Event Group ID ${event.id}.`);
    }
    if (event.source_count !== event.sources.length) {
      throw new Error(
        `Event Group ${event.id} source_count does not match sources length.`,
      );
    }
    ids.add(event.id);
  }
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
