import { JSDOM } from 'jsdom';
import { publicationFromMetadata, sourceName } from '../lib/discovery-source.js';

/** Uses only the current scrape response. Invalid JSON-LD cannot fail content fetching. */
export function extractPublication(metadata: unknown, html?: unknown): string | null {
  const name = publicationFromMetadata(metadata);
  if (name) return name;
  if (typeof html !== 'string' || !html.trim()) return null;
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html);
    for (const element of dom.window.document.querySelectorAll(
      'meta[property="og:site_name"], meta[name="og:site_name"]',
    )) {
      const name = sourceName(element.getAttribute('content'));
      if (name) return name;
    }
    const publisherName = (value: unknown): string | null => {
      if (Array.isArray(value)) return value.map(publisherName).find(Boolean) ?? null;
      if (!value || typeof value !== 'object') return null;
      const item = value as Record<string, unknown>;
      const publisher = item.publisher;
      const names = Array.isArray(publisher) ? publisher : [publisher];
      for (const publisher of names) {
        const name = sourceName(
          typeof publisher === 'object' && publisher
            ? (publisher as Record<string, unknown>).name
            : publisher,
        );
        if (name) return name;
      }
      return publisherName(item['@graph']);
    };
    for (const script of dom.window.document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      let value: unknown;
      try {
        value = JSON.parse(script.textContent ?? '');
      } catch {
        continue;
      } // Malformed optional metadata; try the next block.
      const name = publisherName(value);
      if (name) return name;
    }
    return null;
  } catch (error) {
    console.warn(
      'Discovery publication metadata extraction failed:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    dom?.window.close();
  }
}
