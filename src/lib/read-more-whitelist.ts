import { READ_MORE_FETCH_SOURCES } from '../config/read-more-whitelist.js';

export function canFetchReadMoreArticle(
  sourceName: string | null,
  articleUrl: string | null,
): boolean {
  if (!sourceName || !articleUrl) return false;
  let url: URL;
  try {
    url = new URL(articleUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  return READ_MORE_FETCH_SOURCES.some((source) => {
    if (source.sourceName !== sourceName) return false;
    if (url.hostname === source.hostname) return true;
    if (!url.hostname.endsWith(`.${source.hostname}`)) return false;
    return url.hostname
      .slice(0, -source.hostname.length - 1)
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  });
}

/** SQL columns are fixed, trusted Brief query aliases; values come only from configuration. */
export function readMoreFetchWhitelistSql(sourceColumn: string, urlColumn: string): string {
  return `(${READ_MORE_FETCH_SOURCES.map(({ sourceName, hostname }) => {
    const name = sourceName.replaceAll("'", "''");
    const host = hostname.replaceAll('.', '\\.');
    return `(${sourceColumn} = '${name}' and lower(${urlColumn}) ~ '^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)*${host}(:[0-9]+)?([/?#]|$)')`;
  }).join(' or ')})`;
}
