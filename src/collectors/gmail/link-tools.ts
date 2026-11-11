/** Conservative offline URL evidence utilities; never follows redirects. */
import { safeHttpUrl } from './mail.js';
const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const short = (text: string, max = 320) => (text.length > max ? `${text.slice(0, max)}…` : text);
const targetKeys = new Set([
  'url',
  'href',
  'target',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'destination',
  'dest',
  'link',
]);
const trackerHost =
  /(^|\.)(newslink\.reuters\.com|link\.apnews\.com|customeriomail\.com|beehiiv\.com|beehiivstatus\.com|cmail\d*\.com)$|^url\d*\./;

function decodeValue(value: string): string[] {
  const found: string[] = [];
  const direct = safeHttpUrl(value);
  if (direct) return [direct];
  let decoded = value;
  for (let i = 0; i < 2; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
    const url = safeHttpUrl(decoded);
    if (url) return [url];
  }
  // Only explicit URL/JSON prefixes, never arbitrary encrypted or opaque tracking tokens.
  if (
    decoded.length > 32_000 ||
    !/^(aHR0c|eyJ)/.test(decoded) ||
    !/^[A-Za-z0-9_+/=-]+$/.test(decoded)
  )
    return [];
  try {
    const text = Buffer.from(decoded, 'base64url').toString('utf8');
    const url = safeHttpUrl(text);
    if (url) return [url];
    const object = JSON.parse(text) as Record<string, unknown>;
    for (const [key, value] of Object.entries(object))
      if (targetKeys.has(key.toLowerCase()) && typeof value === 'string') {
        const nested = safeHttpUrl(value);
        if (nested) found.push(nested);
      }
  } catch {
    /* Not an explicit encoded target. Keep the original link. */
  }
  return found;
}

export function inspectUrl(raw: string) {
  const original = safeHttpUrl(raw);
  if (!original) return null;
  const url = new URL(original);
  const candidates: { url: string; method: string }[] = [];
  for (const [key, value] of url.searchParams)
    if (targetKeys.has(key.toLowerCase()))
      for (const target of decodeValue(value))
        candidates.push({ url: target, method: `query:${key}` });
  for (const segment of url.pathname.split('/'))
    for (const target of decodeValue(segment))
      candidates.push({ url: target, method: 'explicit_base64_path' });
  const targets = [...new Set(candidates.map((c) => c.url).filter((u) => u !== original))];
  const resolved = targets.length === 1 ? targets[0] : null;
  const tracking =
    trackerHost.test(url.hostname) || /\/click(?:\/|$)|\/ls\/click|\/ss\/c\//.test(url.pathname);
  // Direct links containing UTM parameters still expose their target; opaque redirectors do not.
  const usable =
    resolved && !trackerHost.test(new URL(resolved).hostname)
      ? resolved
      : !tracking
        ? original
        : null;
  return {
    original_url: original,
    resolved_url: resolved,
    target_url: usable,
    hostname: url.hostname,
    target_hostname: usable ? new URL(usable).hostname : null,
    tracking,
    tracking_parameters: [...url.searchParams.keys()].filter((k) =>
      /^(utm_|cio_|user_email|lc[tu]g)/i.test(k),
    ),
    static_resolution: resolved
      ? candidates.find((c) => c.url === resolved)!.method
      : targets.length > 1
        ? 'ambiguous'
        : tracking
          ? 'opaque'
          : 'direct',
  };
}

/** Exact label + adjacent URL in the independently supplied plain alternative; never infer from link order. */
export function plainAlternativeTarget(plain: string, label: string) {
  const text = clean(plain);
  if (label.length < 12) return null;
  const targets = new Map<string, string>();
  let start = 0;
  for (let occurrences = 0; occurrences < 100; occurrences++) {
    const index = text.indexOf(label, start);
    if (index < 0) break;
    start = index + label.length;
    const suffix = text.slice(start, start + 4096);
    const match = /^[\s\]\[()*_]*((?:https?:\/\/)[^\s\]<>]+?)(?=[)\]\s]|$)/i.exec(suffix);
    if (!match) continue;
    const url = safeHttpUrl(match[1]);
    if (url) targets.set(url, short(text.slice(index, start + match[0].length), 360));
  }
  return targets.size === 1
    ? { url: [...targets.keys()][0], excerpt: [...targets.values()][0] }
    : null;
}

/** Link evidence only: no HTTP requests or guessed redirect targets. */
export function linkEvidence(raw: string, label: string, plainText = '') {
  const inspected = inspectUrl(raw);
  if (!inspected) return null;
  const alternative = !inspected.target_url ? plainAlternativeTarget(plainText, label) : null;
  const target =
    inspected.target_url ?? (alternative ? inspectUrl(alternative.url)?.target_url : null) ?? null;
  return {
    anchor_text: label,
    original_url: inspected.original_url,
    target_url: target,
    target_evidence: inspected.target_url
      ? inspected.static_resolution
      : target
        ? 'plain_text_adjacent_url'
        : 'unknown',
  };
}
