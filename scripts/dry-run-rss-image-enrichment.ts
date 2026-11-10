import { Pool } from 'pg';
import {
  enrichRssImages,
  imageEnrichmentHost,
  type ImageEnrichmentSource,
} from '../src/collectors/rss-image-enrichment.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();

const limit = Number(
  process.argv.find((arg) => arg.startsWith('--per-source='))?.split('=')[1] ?? '1',
);
if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
  throw new Error('--per-source must be an integer from 1 to 5.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

try {
  const sources = await pool.query<ImageEnrichmentSource>(
    `select id, name, url from sources where enabled = true and collection_method = 'RSS'
       and name = any($1::text[]) order by name`,
    [['TechCrunch', 'CNBC: World Top News & Analysis', 'MIT Technology Review']],
  );
  for (const source of sources.rows) {
    if (!imageEnrichmentHost(source)) continue;
    const articles = await pool.query<{ source_item_origin_id: string | null; url: string | null }>(
      `select source_item_origin_id, url from raw_articles
       where source_id = $1 and image_url is null and collected_at >= now() - interval '7 days'
       order by collected_at desc limit $2`,
      [source.id, limit],
    );
    const stats = await enrichRssImages(
      pool,
      source,
      articles.rows.map((row) => ({ sourceItemOriginId: row.source_item_origin_id, url: row.url })),
      { dryRun: true, limit },
    );
    console.log(
      JSON.stringify({
        event: 'rss_image_enrichment_dry_run',
        dryRun: true,
        sourceId: source.id,
        sourceName: source.name,
        ...stats,
      }),
    );
  }
} finally {
  await pool.end();
}
