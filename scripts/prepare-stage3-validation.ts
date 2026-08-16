import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { Pool } from "pg";
import {
  prepareStage3ValidationInput,
  type Stage3DigestRankingInput,
  type Stage3EventRankingInput,
  type Stage3IdMaps,
  type Stage3LongFormRankingInput,
} from "../src/processing/stage3-validation-input.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type DigestCategoryReport = {
  category: string;
  candidateCount: number;
  inputPath: string;
  inputBytes: number;
};

type Stage3ValidationReport = {
  stage: "stage3-validation";
  generatedAt: string;
  sourceStage2Path: string;
  collectedWithinHours: number;
  runDir: string;
  eventGroupCount: number;
  eventInputBytes: number;
  digestCandidateCount: number;
  digestCategories: DigestCategoryReport[];
  longFormCandidateCount: number;
  longFormInputBytes: number;
  idMapPath: string;
  validation: {
    passed: boolean;
    errors: string[];
  };
};

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_STAGE2_SPIKE_RESULT_PATH = "docs/spikes/stage2-merge-result.json";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to prepare Stage 3 validation input.");
  }

  const collectedWithinHours =
    optionalPositiveInteger(process.env.STAGE3_COLLECTED_WITHIN_HOURS) ?? DEFAULT_LOOKBACK_HOURS;
  const stage2MergeResultPath =
    process.env.STAGE3_STAGE2_MERGE_RESULT_PATH ?? (await findLatestStage2MergeArtifactPath());
  const startedAt = new Date();
  const runDir = join("runtime/stage3-validation", toRunTimestamp(startedAt));
  const digestDir = join(runDir, "digest");

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
    const prepared = await prepareStage3ValidationInput(pool, {
      collectedWithinHours,
      stage2MergeResultPath,
    });
    const validation = validatePreparedInput(
      prepared.eventInput,
      prepared.digestInputs,
      prepared.longFormInput,
      prepared.idMaps,
    );

    await mkdir(digestDir, { recursive: true });

    const eventsInputPath = join(runDir, "events-input.json");
    const longFormInputPath = join(runDir, "long-form-input.json");
    const idMapPath = join(runDir, "id-map.json");
    const runPath = join(runDir, "run.json");

    const eventInputBytes = await writeJsonAndReturnBytes(eventsInputPath, prepared.eventInput);
    const longFormInputBytes = await writeJsonAndReturnBytes(
      longFormInputPath,
      prepared.longFormInput,
    );
    await writeJsonAndReturnBytes(idMapPath, prepared.idMaps);

    const digestCategories: DigestCategoryReport[] = [];
    for (const input of Object.values(prepared.digestInputs)) {
      if (input.candidates.length === 0) {
        continue;
      }

      const inputPath = join(digestDir, `${toSlug(input.category)}-input.json`);
      const inputBytes = await writeJsonAndReturnBytes(inputPath, input);
      digestCategories.push({
        category: input.category,
        candidateCount: input.candidates.length,
        inputPath,
        inputBytes,
      });
    }

    const report: Stage3ValidationReport = {
      stage: "stage3-validation",
      generatedAt: startedAt.toISOString(),
      sourceStage2Path: prepared.sourceStage2Path,
      collectedWithinHours,
      runDir,
      eventGroupCount: prepared.eventInput.events.length,
      eventInputBytes,
      digestCandidateCount: Object.values(prepared.digestInputs).reduce(
        (sum, input) => sum + input.candidates.length,
        0,
      ),
      digestCategories,
      longFormCandidateCount: prepared.longFormInput.candidates.length,
      longFormInputBytes,
      idMapPath,
      validation,
    };

    await writeJsonAndReturnBytes(runPath, report);
    console.log(JSON.stringify(report, null, 2));

    if (!validation.passed) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

async function findLatestStage2MergeArtifactPath(): Promise<string> {
  const runtimeRoot = "runtime/stage2";
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runtimeRoot, entry.name))
      .sort()
      .reverse();

    for (const candidate of candidates) {
      if (await isSuccessfulStage2RuntimeDir(candidate)) {
        return candidate;
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  return DEFAULT_STAGE2_SPIKE_RESULT_PATH;
}

async function isSuccessfulStage2RuntimeDir(path: string): Promise<boolean> {
  try {
    const run = JSON.parse(await readFile(join(path, "run.json"), "utf8")) as { status?: string };
    await stat(join(path, "input.json"));
    await stat(join(path, "id-map.json"));
    await stat(join(path, "output.json"));
    return run.status === "success";
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function validatePreparedInput(
  eventInput: Stage3EventRankingInput,
  digestInputs: Record<string, Stage3DigestRankingInput>,
  longFormInput: Stage3LongFormRankingInput,
  idMaps: Stage3IdMaps,
): { passed: boolean; errors: string[] } {
  const errors: string[] = [];

  validateUniqueIds(
    "events",
    eventInput.events.map((event) => event.id),
    errors,
  );
  for (const event of eventInput.events) {
    if (!idMaps.events[event.id] || idMaps.events[event.id].length === 0) {
      errors.push(`Missing event id-map entry for ${event.id}.`);
    }
  }

  const eventProcessedIds = Object.values(idMaps.events).flat();
  validateUniqueIds("event processed_content_id", eventProcessedIds, errors);

  for (const [category, input] of Object.entries(digestInputs)) {
    const ids = input.candidates.map((candidate) => candidate.id);
    validateUniqueIds(`digest ${category}`, ids, errors);
    const categoryMap = idMaps.digest[category] ?? {};
    for (const id of ids) {
      if (!categoryMap[id]) {
        errors.push(`Missing digest id-map entry for ${category}/${id}.`);
      }
    }
  }

  validateUniqueIds(
    "long_form",
    longFormInput.candidates.map((candidate) => candidate.id),
    errors,
  );
  for (const candidate of longFormInput.candidates) {
    if (!idMaps.long_form[candidate.id]) {
      errors.push(`Missing long_form id-map entry for ${candidate.id}.`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

function validateUniqueIds(label: string, ids: string[], errors: string[]) {
  const duplicates = findDuplicates(ids);
  for (const duplicate of duplicates) {
    errors.push(`Duplicate ${label} id ${duplicate}.`);
  }
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

async function writeJsonAndReturnBytes(path: string, value: unknown): Promise<number> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, content);
  return Buffer.byteLength(content, "utf8");
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`Expected a positive integer, got "${value}".`);
  }

  return numberValue;
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
