import type { Pool } from 'pg';
import type { DiscoverySource } from './discovery-source.js';

/** Reuse the existing imported source list; no Discovery-owned registry. */
export async function loadDiscoverySources(db: Pick<Pool, 'query'>): Promise<DiscoverySource[]> {
  const result = await db.query<DiscoverySource>('select name, url from sources order by name');
  return result.rows;
}
