import {
  ACTIVE_FRAGMENT_KEYS,
  FRAGMENT_KEYS,
  type PromptBody,
  type PromptVersion,
} from './contracts.js';

type Fragment = Pick<PromptVersion, 'id' | 'key'>;
/** Convert only the local editor copy; Published bodies and hashes remain untouched. */
export function keyReferenceBody(body: PromptBody, fragments: readonly Fragment[]): PromptBody {
  const aliases = new Map<string, string>();
  const refs = body.fragments.map((ref) => {
    if (ref.key) return ref;
    const key = ref.activeKey ?? fragments.find((f) => f.id === ref.versionId)?.key;
    if (!key || !(FRAGMENT_KEYS as readonly string[]).includes(key))
      throw new Error('历史 Fragment 版本无法解析，请先恢复该引用。');
    aliases.set(`fragment.${ref.slot}`, `fragment.${key}`);
    return ref.activeKey
      ? { key: key as (typeof FRAGMENT_KEYS)[number], activeKey: ref.activeKey }
      : { key: key as (typeof FRAGMENT_KEYS)[number], versionId: ref.versionId };
  });
  const convert = (text: string | null) =>
    text?.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, (token, name: string) =>
      aliases.has(name) ? `{{${aliases.get(name)}}}` : token,
    ) ?? null;
  return {
    ...body,
    fragments: refs,
    systemInstructions: convert(body.systemInstructions),
    variants: Object.fromEntries(
      Object.entries(body.variants).map(([name, roles]) => [
        name,
        { ...roles, systemInstructions: convert(roles.systemInstructions) },
      ]),
    ),
  };
}
/** Keep references used in any System variant. Ordinary versions require explicit selection. */
export function syncKeyReferences(body: PromptBody): PromptBody {
  const keys = new Set<string>();
  for (const roles of [body, ...Object.values(body.variants)]) {
    for (const match of (roles.systemInstructions ?? '').matchAll(
      /\{\{\s*fragment\.([a-z][a-z0-9_.]*)\s*\}\}/g,
    )) {
      if ((FRAGMENT_KEYS as readonly string[]).includes(match[1])) keys.add(match[1]);
    }
  }
  return {
    ...body,
    fragments: [...keys].map((key) => {
      const existing = body.fragments.find((ref) => ref.key === key);
      if (existing) return existing;
      return (ACTIVE_FRAGMENT_KEYS as readonly string[]).includes(key)
        ? {
            key: key as (typeof FRAGMENT_KEYS)[number],
            activeKey: key as (typeof ACTIVE_FRAGMENT_KEYS)[number],
          }
        : { key: key as (typeof FRAGMENT_KEYS)[number] };
    }),
  };
}
