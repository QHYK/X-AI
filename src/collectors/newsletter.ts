import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { insertRawArticle, type NormalizedRawArticle } from './raw-articles.js';

const identity = z.object({
  gmail_message_id: z.string().min(1),
  unit_id: z.string().min(1),
  content_type: z.enum(['standalone_content', 'external_reference', 'non_content']),
});

/** A small ingestion boundary, not a Gmail scheduler. All writers through this entry serialize per Source. */
export async function persistNewsletterArticles(
  pool: Pool,
  sourceId: string,
  articles: NormalizedRawArticle[],
) {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level read committed');
    await client.query("set local lock_timeout = '5s'");
    const result = await persistNewsletterArticlesInTransaction(client, sourceId, articles);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      console.error('[newsletter] rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Caller owns BEGIN/COMMIT/ROLLBACK; never acquires another Pool Client. */
export async function persistNewsletterArticlesInTransaction(
  client: PoolClient,
  sourceId: string,
  articles: NormalizedRawArticle[],
) {
  for (const article of articles) {
    const unit = identity.parse(article.metadata?.newsletter);
    if (article.sourceItemOriginId !== `gmail:${unit.gmail_message_id}:${unit.unit_id}`)
      throw new Error('Newsletter module identity does not match its origin ID');
    if (
      !article.title.trim() ||
      !article.contentText?.trim() ||
      !article.publishedAt ||
      !Number.isFinite(article.publishedAt.getTime())
    )
      throw new Error('Newsletter title, body and received timestamp are required');
  }
  let inserted = 0;
  const source = await client.query(
    `select id from sources
        where id = $1 and enabled = true and lower(btrim(collection_method)) = 'email'
        for update`,
    [sourceId],
  );
  if (source.rows.length !== 1) throw new Error('An enabled Email Source is required');
  for (const article of articles) {
    const existing = await client.query(
      'select id from raw_articles where source_id = $1 and source_item_origin_id = $2 limit 1',
      [sourceId, article.sourceItemOriginId],
    );
    if (existing.rows.length) continue;
    await insertRawArticle(client, sourceId, article);
    inserted++;
  }
  return { inserted, skipped: articles.length - inserted };
}
