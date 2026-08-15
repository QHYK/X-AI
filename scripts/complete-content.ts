import { config } from "dotenv";
import { Pool } from "pg";
import { completeRawArticleContent } from "../src/processing/content-completion.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to complete raw article content.");
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
    const summary = await completeRawArticleContent(pool, {
      sourceNames: parseSourceNames(process.env.CONTENT_COMPLETION_SOURCE_NAMES),
      limit: optionalNumber(process.env.CONTENT_COMPLETION_LIMIT),
      perSourceLimit: optionalNumber(process.env.CONTENT_COMPLETION_PER_SOURCE_LIMIT),
      concurrency: optionalNumber(process.env.CONTENT_COMPLETION_CONCURRENCY),
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

function parseSourceNames(value: string | undefined): string[] | undefined {
  const sourceNames = value
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return sourceNames && sourceNames.length > 0 ? sourceNames : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`Expected a positive number, got "${value}".`);
  }

  return numberValue;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
