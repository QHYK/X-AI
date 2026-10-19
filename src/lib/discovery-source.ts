/** Shared by all Discovery paths and read-time legacy fallback; never treats an author as a source. */
export function sourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (
    !name ||
    name.length > 300 ||
    /^(?:unknown|source unknown|unknown source|null|undefined|n\/?a|none|home(?:page)?|website|web site|site name|site title|website name|your (?:website|site)(?: name)?|article|untitled|wordpress|just another wordpress site|网站|首页|未知|来源未知)$/i.test(
      name,
    )
  )
    return null;
  if (/https?:\/\/|[<>]|\{\{|\}\}/i.test(name)) return null;
  return name;
}

export function sourceHostname(value: unknown): string | null {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname
      ? url.hostname.toLowerCase().replace(/^(?:www\d*|m)\./, '')
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only explicit site/publisher metadata, never title, author or an arbitrary JSON-LD name. */
export function publicationFromMetadata(value: unknown): string | null {
  const metadata = object(value);
  const publisher = object(metadata.publisher);
  for (const value of [
    metadata['og:site_name'],
    metadata.ogSiteName,
    metadata.siteName,
    metadata.site_name,
    metadata.publisherName,
    metadata.publication,
    publisher.name,
    metadata.publisher,
  ]) {
    const name = sourceName(value);
    if (name) return name;
  }
  return null;
}

export type DiscoverySource = { name: string; url: string };
export function resolveDiscoveryPublication(input: {
  url: unknown;
  metadata?: unknown;
  dailySource?: unknown;
  publication?: unknown;
  sources?: DiscoverySource[];
}): string {
  const existing =
    publicationFromMetadata(input.metadata) ??
    sourceName(input.dailySource) ??
    sourceName(input.publication);
  const hostname = sourceHostname(input.url);
  if (existing && existing.toLowerCase() !== hostname) return existing;
  const configured =
    hostname &&
    input.sources?.find(
      (source) => sourceHostname(source.url) === hostname && sourceName(source.name),
    );
  return (configured && sourceName(configured.name)) || existing || hostname || 'Unknown';
}

export function discoveryEvidenceMetadata(evidence: unknown): unknown {
  const value = object(evidence);
  return object(value.fetch).metadata ?? value.sourceMetadata;
}
