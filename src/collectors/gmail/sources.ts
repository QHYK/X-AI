import type { Pool, PoolClient } from 'pg';

/** Accepted templates map to existing branded Email sources; no automatic source creation. */
export const NEWSLETTER_SOURCE_NAMES: Record<string, { name: string; address: string }> = {
  'Reuters Daily Briefing': {
    name: 'Reuters Daily Briefing',
    address: 'dailybriefing@thomsonreuters.com',
  },
  'Reuters One Essential Read': {
    name: 'Reuters Daily Briefing',
    address: 'dailybriefing@thomsonreuters.com',
  },
  增长黑客AI周报: { name: '增长黑客AI周报', address: 'ghacker@substack.com' },
  Superhuman: { name: 'Superhuman', address: 'superhuman@mail.joinsuperhuman.ai' },
  'The Associated Press': { name: 'The Associated Press', address: 'morningwire@apnews.com' },
  'The Daily Upside': { name: 'The Daily Upside', address: 'squad@thedailyupside.com' },
  'The Information AM': { name: 'The Information', address: 'hello@theinformation.com' },
  'The Information Briefing': { name: 'The Information', address: 'hello@theinformation.com' },
};
export type NewsletterSourceRow = { id: string; name: string; url: string };
export async function loadNewsletterSources(db: Pick<Pool | PoolClient, 'query'>) {
  const result = await db.query<NewsletterSourceRow>(
    `select id,name,url from sources where enabled=true and lower(btrim(collection_method))='email'`,
  );
  const mapping = new Map<string, NewsletterSourceRow>();
  for (const [template, expected] of Object.entries(NEWSLETTER_SOURCE_NAMES)) {
    const matches = result.rows.filter(
      (r) => r.name === expected.name && r.url.trim().toLowerCase() === expected.address,
    );
    // The new optional source must not block collection for existing configured sources.
    if (template === '增长黑客AI周报' && matches.length === 0) continue;
    if (matches.length !== 1)
      throw new Error(`Newsletter Source mapping missing or ambiguous: ${template}`);
    mapping.set(template, matches[0]);
  }
  return mapping;
}
