import { mkdir, stat, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool } from "pg";
import {
  loadStage2EventCandidates,
  prepareStage2Input,
  type Stage2CandidateRow,
  type Stage2Input,
  type Stage2IdMap,
} from "../src/processing/stage2-candidates.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type SizeReport = {
  eventCandidateCount: number;
  inputFileBytes: number;
  titleChars: number;
  summaryChars: number;
  totalInputChars: number;
  uniqueTempIds: number;
  uniqueProcessedContentIds: number;
  missingMappings: number;
  duplicateProcessedContentIds: string[];
};

const INPUT_PATH = "docs/spikes/stage2-input.json";
const ID_MAP_PATH = "docs/spikes/stage2-id-map.json";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to prepare Stage 2 validation input.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  try {
    const rows = await loadStage2EventCandidates(pool);
    const prepared = prepareStage2Input(rows);

    await mkdir("docs/spikes", { recursive: true });
    await writeFile(INPUT_PATH, `${JSON.stringify(prepared.input, null, 2)}\n`);
    await writeFile(
      ID_MAP_PATH,
      `${JSON.stringify({ generated_at: new Date().toISOString(), mapping: prepared.idMap }, null, 2)}\n`,
    );

    const inputStat = await stat(INPUT_PATH);
    const report = buildSizeReport(prepared.input, prepared.idMap, rows, inputStat.size);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

function buildSizeReport(
  input: Stage2Input,
  idMap: Stage2IdMap,
  rows: Stage2CandidateRow[],
  inputFileBytes: number,
): SizeReport {
  const titleChars = input.event_candidates.reduce(
    (sum, candidate) => sum + candidate.title.length,
    0,
  );
  const summaryChars = input.event_candidates.reduce(
    (sum, candidate) => sum + candidate.summary.length,
    0,
  );
  const tempIds = input.event_candidates.map((candidate) => candidate.temp_id);
  const processedContentIds = rows.map((row) => row.processedContentId);

  return {
    eventCandidateCount: input.event_candidates.length,
    inputFileBytes,
    titleChars,
    summaryChars,
    totalInputChars: JSON.stringify(input).length,
    uniqueTempIds: new Set(tempIds).size,
    uniqueProcessedContentIds: new Set(processedContentIds).size,
    missingMappings: tempIds.filter((tempId) => !idMap[tempId]).length,
    duplicateProcessedContentIds: findDuplicates(processedContentIds),
  };
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
