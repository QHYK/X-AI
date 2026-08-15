import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { config } from "dotenv";
import { Pool, type PoolClient } from "pg";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type SourceCsvRow = {
  Source: string;
  Category: string;
  "Source Type": string;
  URL: string;
  "Collection Method": string;
  Priority: string;
  Enabled: string;
  "Event Candidate": string;
  "Source Digest Candidate": string;
  Availability: string;
  Language: string;
  Notes: string;
};

type SourceSeed = {
  name: string;
  category: string;
  sourceType: string | null;
  url: string;
  collectionMethod: string;
  priority: string;
  enabled: boolean;
  eventCandidate: boolean;
  sourceDigestCandidate: boolean;
  language: string;
  availability: string | null;
  notes: string | null;
};

type ImportSummary = {
  parsed: number;
  inserted: number;
  updated: number;
  disabledMissing: number;
  totalInDatabaseForSeedUrls: number;
  categoryCounts: Record<string, number>;
  collectionMethodCounts: Record<string, number>;
};

const SOURCE_LIST_PATH = "docs/05-source-list.md";
const REQUIRED_HEADERS = [
  "Source",
  "Category",
  "Source Type",
  "URL",
  "Collection Method",
  "Priority",
  "Enabled",
  "Event Candidate",
  "Source Digest Candidate",
  "Availability",
  "Language",
  "Notes",
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to import sources.");
  }

  const seeds = await loadSourceSeeds();
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
    const summary = await importSources(pool, seeds);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

async function loadSourceSeeds(): Promise<SourceSeed[]> {
  const markdown = await readFile(SOURCE_LIST_PATH, "utf8");
  const csv = extractCsvBlock(markdown);
  const rows = parse(csv, {
    columns: normalizeHeaders,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as SourceCsvRow[];

  validateHeaders(rows);

  const seeds = rows.map(mapRowToSeed);
  assertNoDuplicateUrls(seeds);
  assertNoDuplicateSourceIdentities(seeds);

  return seeds;
}

function normalizeHeaders(headers: string[]): string[] {
  return headers.map((header) => {
    const normalized = header.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("Language")) {
      return "Language";
    }

    if (normalized.startsWith("Notes")) {
      return "Notes";
    }

    return normalized;
  });
}

function extractCsvBlock(markdown: string): string {
  const match = markdown.match(/```csv\s*([\s\S]*?)```/);
  if (!match?.[1]?.trim()) {
    throw new Error(`No csv fenced block found in ${SOURCE_LIST_PATH}.`);
  }

  return match[1];
}

function validateHeaders(rows: SourceCsvRow[]) {
  if (rows.length === 0) {
    throw new Error("Source list CSV is empty.");
  }

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !(header in rows[0]));
  if (missingHeaders.length > 0) {
    throw new Error(`Source list is missing required headers: ${missingHeaders.join(", ")}`);
  }
}

function mapRowToSeed(row: SourceCsvRow): SourceSeed {
  return {
    name: requiredText(row.Source, "Source"),
    category: normalizeCategory(requiredText(row.Category, "Category")),
    sourceType: nullableText(row["Source Type"]),
    url: requiredText(row.URL, "URL"),
    collectionMethod: requiredText(row["Collection Method"], "Collection Method"),
    priority: requiredText(row.Priority, "Priority"),
    enabled: parseYesNo(row.Enabled, "Enabled"),
    eventCandidate: parseYesNo(row["Event Candidate"], "Event Candidate"),
    sourceDigestCandidate: parseYesNo(
      row["Source Digest Candidate"],
      "Source Digest Candidate",
    ),
    availability: nullableText(row.Availability),
    language: requiredText(row.Language, "Language"),
    notes: nullableText(row.Notes),
  };
}

function normalizeCategory(category: string): string {
  if (["Economics", "Business", "Financial", "Market"].includes(category)) {
    return "Finance & Economy";
  }

  if (["AI", "Technology"].includes(category)) {
    return "Technology";
  }

  return category;
}

function parseYesNo(value: string, fieldName: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") {
    return true;
  }

  if (normalized === "no") {
    return false;
  }

  throw new Error(`${fieldName} must be Yes or No, got "${value}".`);
}

function requiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmed;
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assertNoDuplicateUrls(seeds: SourceSeed[]) {
  const counts = countBy(seeds, (seed) => seed.url);
  const duplicates = Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([url]) => url);

  if (duplicates.length > 0) {
    throw new Error(`Source list contains duplicate URL/email values: ${duplicates.join(", ")}`);
  }
}

function assertNoDuplicateSourceIdentities(seeds: SourceSeed[]) {
  const counts = countBy(seeds, sourceIdentity);
  const duplicates = Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([identity]) => identity);

  if (duplicates.length > 0) {
    throw new Error(`Source list contains duplicate source identities: ${duplicates.join(", ")}`);
  }
}

async function importSources(pool: Pool, seeds: SourceSeed[]): Promise<ImportSummary> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await assertNoDuplicateDatabaseUrls(client, seeds.map((seed) => seed.url));
    await assertNoDuplicateDatabaseSourceIdentities(client);

    let inserted = 0;
    let updated = 0;

    for (const seed of seeds) {
      const result = await client.query(
        `
          update sources
          set
            url = $1,
            name = $2,
            category = $3,
            source_type = $4,
            collection_method = $5,
            priority = $6,
            enabled = $7,
            event_candidate = $8,
            source_digest_candidate = $9,
            language = $10,
            availability = $11,
            notes = $12,
            updated_at = now()
          where name = $2
            and collection_method = $5
        `,
        sourceParams(seed),
      );

      const updatedCount = result.rowCount ?? 0;

      if (updatedCount === 0) {
        await client.query(
          `
            insert into sources (
              url,
              name,
              category,
              source_type,
              collection_method,
              priority,
              enabled,
              event_candidate,
              source_digest_candidate,
              language,
              availability,
              notes
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          sourceParams(seed),
        );
        inserted += 1;
      } else {
        updated += updatedCount;
      }
    }

    const disabledMissing = await disableMissingSources(client, seeds);

    const totalResult = await client.query<{ count: string }>(
      "select count(*)::int as count from sources where url = any($1)",
      [seeds.map((seed) => seed.url)],
    );

    await client.query("commit");

    return {
      parsed: seeds.length,
      inserted,
      updated,
      disabledMissing,
      totalInDatabaseForSeedUrls: Number(totalResult.rows[0]?.count ?? 0),
      categoryCounts: countBy(seeds, (seed) => seed.category),
      collectionMethodCounts: countBy(seeds, (seed) => seed.collectionMethod),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function assertNoDuplicateDatabaseUrls(client: PoolClient, urls: string[]) {
  const result = await client.query<{ url: string; count: string }>(
    `
      select url, count(*)::int as count
      from sources
      where url = any($1)
      group by url
      having count(*) > 1
    `,
    [urls],
  );

  if (result.rows.length > 0) {
    const duplicates = result.rows.map((row) => `${row.url} (${row.count})`).join(", ");
    throw new Error(`Database already contains duplicate source URL/email values: ${duplicates}`);
  }
}

async function assertNoDuplicateDatabaseSourceIdentities(client: PoolClient) {
  const result = await client.query<{ identity: string; count: string }>(
    `
      select name || ' / ' || collection_method as identity, count(*)::int as count
      from sources
      group by name, collection_method
      having count(*) > 1
    `,
  );

  if (result.rows.length > 0) {
    const duplicates = result.rows.map((row) => `${row.identity} (${row.count})`).join(", ");
    throw new Error(`Database already contains duplicate source identities: ${duplicates}`);
  }
}

async function disableMissingSources(client: PoolClient, seeds: SourceSeed[]): Promise<number> {
  const identities = new Set(seeds.map(sourceIdentity));
  const existingSources = await client.query<{
    id: string;
    name: string;
    collection_method: string;
    enabled: boolean;
  }>(
    `
      select id, name, collection_method, enabled
      from sources
    `,
  );

  let disabled = 0;

  for (const source of existingSources.rows) {
    const identity = `${source.name}\u0000${source.collection_method}`;
    if (source.enabled && !identities.has(identity)) {
      await client.query(
        `
          update sources
          set enabled = false,
              updated_at = now()
          where id = $1
        `,
        [source.id],
      );
      disabled += 1;
    }
  }

  return disabled;
}

function sourceParams(seed: SourceSeed) {
  return [
    seed.url,
    seed.name,
    seed.category,
    seed.sourceType,
    seed.collectionMethod,
    seed.priority,
    seed.enabled,
    seed.eventCandidate,
    seed.sourceDigestCandidate,
    seed.language,
    seed.availability,
    seed.notes,
  ];
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function sourceIdentity(seed: SourceSeed): string {
  return `${seed.name}\u0000${seed.collectionMethod}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
