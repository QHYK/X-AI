import { JSDOM } from 'jsdom';
import { safeImageUrl, type DiscoveryCover } from '../lib/discovery-content-metadata.js';

const EXCLUDED =
  /(?:^|[\s/_.-])(logos?|avatars?|icons?|badges?|pixels?|tracking|ads?|advert(?:isement)?s?|sponsors?|gravatar|profiles?|related|recommendations?|newsletter)(?:[\s/_.-]|$)/i;

function dimension(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
}

function image(
  value: unknown,
  base: string,
  source: DiscoveryCover['source'],
  width: unknown = null,
  height: unknown = null,
  description = '',
): DiscoveryCover | null {
  const url = safeImageUrl(value, base);
  if (
    !url ||
    EXCLUDED.test(`${new URL(url).pathname} ${description}`) ||
    /\.(?:svg|gif|ico)$/i.test(new URL(url).pathname)
  )
    return null;
  const w = dimension(width);
  const h = dimension(height);
  if ((w !== null && w < 600) || (h !== null && h < 300)) return null;
  if (w !== null && h !== null && (w / h > 3.5 || w / h < 0.5)) return null;
  // Body images need declared size evidence. Social metadata itself establishes editorial relevance.
  if (source === 'article' && w === null) return null;
  return { url, source, width: w, height: h };
}

/** Already-associated Daily image; never refetch a Direct source merely to obtain a cover. */
export function coverFromRawArticle(
  value: unknown,
  articleUrl: string,
  metadata?: unknown,
): DiscoveryCover | null {
  return (
    extractArticleCover({ url: articleUrl, metadata }) ?? image(value, articleUrl, 'raw_article')
  );
}

/** Pure extraction from the existing scrape response. No image downloads or extra requests. */
export function extractArticleCover(input: {
  url: string;
  metadata?: unknown;
  html?: unknown;
}): DiscoveryCover | null {
  let dom: JSDOM | undefined;
  try {
    const metadata =
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? (input.metadata as Record<string, unknown>)
        : {};
    dom = typeof input.html === 'string' && input.html.trim() ? new JSDOM(input.html) : undefined;
    const doc = dom?.window.document;
    const meta = (name: string) =>
      Array.from(doc?.querySelectorAll('meta') ?? [])
        .find(
          (element) =>
            (element.getAttribute('property') ?? element.getAttribute('name'))?.toLowerCase() ===
            name,
        )
        ?.getAttribute('content');
    for (const [key, alias] of [
      ['og:image', 'ogImage'],
      ['twitter:image', 'twitterImage'],
    ] as const) {
      const values = [
        metadata[key],
        metadata[alias],
        meta(key),
        key === 'og:image' ? meta('og:image:secure_url') : meta('twitter:image:src'),
      ];
      for (const value of values) {
        const cover = image(
          value,
          input.url,
          key,
          metadata[`${key}:width`] ?? metadata[`${alias}Width`] ?? meta(`${key}:width`),
          metadata[`${key}:height`] ?? metadata[`${alias}Height`] ?? meta(`${key}:height`),
        );
        if (cover) return cover;
      }
    }
    const root = doc?.querySelector('article, [itemprop="articleBody"], main') ?? doc?.body;
    for (const img of Array.from(root?.querySelectorAll('img') ?? [])) {
      if (img.closest('header, footer, nav, aside, [role="banner"], [role="complementary"]'))
        continue;
      let excludedParent = false;
      for (
        let parent = img.parentElement;
        parent && parent !== root;
        parent = parent.parentElement
      ) {
        if (EXCLUDED.test(`${parent.className} ${parent.id}`)) {
          excludedParent = true;
          break;
        }
      }
      if (excludedParent) continue;
      const description = `${img.getAttribute('alt') ?? ''} ${img.className}`;
      const srcset = (img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? '')
        .split(',')
        .map((entry) => entry.trim().match(/^(\S+)\s+(\d+)w$/))
        .filter((entry): entry is RegExpMatchArray => entry !== null)
        .sort((left, right) => Number(right[2]) - Number(left[2]));
      for (const entry of srcset) {
        const cover = image(entry[1], input.url, 'article', Number(entry[2]), null, description);
        if (cover) return cover;
      }
      const cover = image(
        img.getAttribute('data-src') ?? img.getAttribute('src'),
        input.url,
        'article',
        img.getAttribute('width'),
        img.getAttribute('height'),
        description,
      );
      if (cover) return cover;
    }
    return null;
  } catch (error) {
    console.warn(
      'Discovery cover extraction failed; keeping readable content.',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    dom?.window.close();
  }
}
