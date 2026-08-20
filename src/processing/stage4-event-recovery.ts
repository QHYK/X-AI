import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  validateStage4EventEnrichmentOutput,
  type Stage4EventEnrichmentOutput,
} from "./stage4-contract.js";
import { deriveEventDate } from "./event-date.js";

type Queryable = Pick<Pool, "query">;

type RunArtifact = {
  status?: string;
  timestamp?: string;
  finished_at?: string;
};

type PersistenceArtifact = {
  created_event_ids?: string[];
  event_group_to_event_id?: Record<string, string>;
};

type PersistencePlanArtifact = {
  events?: Array<{
    event_group_id: string;
    processed_content_ids: string[];
    rank: number;
    event_date?: string;
  }>;
};

type MappingArtifact = {
  event_date?: string;
  processed_content_ids?: string[];
  rank?: number;
};

export type Stage4RecoveryCandidate = {
  runDir: string;
  eventGroupId: string;
  originalEventId: string | null;
  originalEventExists: boolean;
  eventDate: string | null;
  eventDateSource: "artifact" | "derived_from_processed_contents" | "missing";
  rank: number | null;
  processedContentIds: string[];
  output: Stage4EventEnrichmentOutput | null;
  createdAt: string | null;
  requiredFieldsAvailable: boolean;
};

export async function loadStage4RecoveryCandidates(
  database: Queryable,
  rootDir = process.cwd(),
): Promise<Stage4RecoveryCandidate[]> {
  const runtimeRoot = join(rootDir, "runtime/stage4");
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  const candidates: Stage4RecoveryCandidate[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDir = join(runtimeRoot, entry.name);
    const run = await readJson<RunArtifact>(join(runDir, "run.json"));
    if (run.status !== "success") {
      continue;
    }

    const persistence = await readJson<PersistenceArtifact>(join(runDir, "persistence.json"));
    const plan = await readJson<PersistencePlanArtifact>(join(runDir, "persistence-plan.json"));
    const existingIds = await loadExistingEventIds(database, persistence.created_event_ids ?? []);

    for (const event of plan.events ?? []) {
      const eventId = persistence.event_group_to_event_id?.[event.event_group_id] ?? null;
      const mapping = await readOptionalJson<MappingArtifact>(
        join(runDir, "events", event.event_group_id, "mapping.json"),
      );
      const rawOutput = await readOptionalJson<unknown>(
        join(runDir, "events", event.event_group_id, "output.json"),
      );
      const outputValidation = validateStage4EventEnrichmentOutput(rawOutput);
      const output = outputValidation.success ? outputValidation.output : null;
      const processedContentIds =
        event.processed_content_ids ?? mapping?.processed_content_ids ?? [];
      const eventDateFromArtifact = event.event_date ?? mapping?.event_date ?? null;
      const eventDate =
        eventDateFromArtifact ??
        (await deriveEventDateFromProcessedContents(
          database,
          processedContentIds,
          run.timestamp,
        ));
      const rank = event.rank ?? mapping?.rank ?? null;
      const createdAt = run.finished_at ?? run.timestamp ?? null;

      candidates.push({
        runDir,
        eventGroupId: event.event_group_id,
        originalEventId: eventId,
        originalEventExists: eventId !== null && existingIds.has(eventId),
        eventDate,
        eventDateSource: eventDateFromArtifact
          ? "artifact"
          : eventDate
            ? "derived_from_processed_contents"
            : "missing",
        rank,
        processedContentIds,
        output,
        createdAt,
        requiredFieldsAvailable:
          eventId !== null &&
          processedContentIds.length > 0 &&
          typeof rank === "number" &&
          output !== null &&
          createdAt !== null &&
          eventDate !== null,
      });
    }
  }

  return candidates;
}

export function selectLatestMissingCandidatesByEventDate(
  candidates: Stage4RecoveryCandidate[],
): Stage4RecoveryCandidate[] {
  const completeCandidates = candidates.filter(
    (candidate) => candidate.requiredFieldsAvailable && candidate.eventDate !== null,
  );
  const latestRunByDate = new Map<string, string>();

  for (const candidate of completeCandidates) {
    const eventDate = candidate.eventDate as string;
    const current = latestRunByDate.get(eventDate);
    if (!current || candidate.runDir > current) {
      latestRunByDate.set(eventDate, candidate.runDir);
    }
  }

  return completeCandidates.filter(
    (candidate) =>
      !candidate.originalEventExists &&
      latestRunByDate.get(candidate.eventDate as string) === candidate.runDir,
  );
}

export function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

async function loadExistingEventIds(
  database: Queryable,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }

  const result = await database.query<{ id: string }>(
    `select id from events where id = any($1::uuid[])`,
    [eventIds],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function deriveEventDateFromProcessedContents(
  database: Queryable,
  processedContentIds: string[],
  workflowRunTimestamp: string | undefined,
): Promise<string | null> {
  if (processedContentIds.length === 0 || !workflowRunTimestamp) {
    return null;
  }

  const result = await database.query<{ published_at: Date | null }>(
    `
      select ra.published_at
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = any($1::uuid[])
    `,
    [processedContentIds],
  );

  return deriveEventDate({
    publishedAtValues: result.rows.map((row) => row.published_at),
    workflowRunTimestamp,
  }).eventDate;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
