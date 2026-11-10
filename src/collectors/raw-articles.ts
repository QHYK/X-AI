import type { PoolClient } from 'pg';

export type NormalizedRawArticle = {
  sourceItemOriginId: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: Date | null;
  contentText: string | null;
  imageUrl: string | null;
  sourceTags: string[] | null;
  metadata: Record<string, unknown> | null;
};

export async function insertRawArticle(
  client: PoolClient,
  sourceId: string,
  article: NormalizedRawArticle,
) {
  await client.query(
    `
      insert into raw_articles (
        source_id,
        source_item_origin_id,
        title,
        url,
        author,
        published_at,
        collected_at,
        content_text,
        image_url,
        source_tags,
        metadata,
        stage1_status
      )
      values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, 'pending')
    `,
    [
      sourceId,
      article.sourceItemOriginId,
      article.title,
      article.url,
      article.author,
      article.publishedAt,
      article.contentText,
      article.imageUrl,
      article.sourceTags,
      JSON.stringify(article.metadata),
    ],
  );
}
