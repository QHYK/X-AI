import {
  ACTIVE_FRAGMENT_KEYS,
  validatePromptBody,
  type PromptBody,
  type PromptKey,
  type PromptVersion,
} from './contracts.js';

import { keyReferenceBody } from './fragment-editor.js';

export const SYSTEM_LAYER_NOTE = 'system-fragments-v1:previous=';
export function addSystemPromptLayers(
  key: PromptKey,
  original: PromptBody,
  fragments: readonly Pick<PromptVersion, 'id' | 'key'>[] = [],
): PromptBody {
  const editorial = key.startsWith('daily.')
    ? 'daily_brief.editorial'
    : key.startsWith('discovery.')
      ? 'discover.editorial'
      : null;
  if (!editorial) return original;
  const dynamic = original.fragments.filter(
    (ref) => ref.activeKey && (ACTIVE_FRAGMENT_KEYS as readonly string[]).includes(ref.activeKey),
  );
  if (dynamic.length) {
    if (
      original.fragments[0]?.activeKey === 'xfield.identity' &&
      original.fragments[1]?.activeKey === editorial &&
      dynamic.length === 2
    )
      return validatePromptBody(key, 'request', original);
    throw new Error(`Partially configured System layers require manual review: ${key}`);
  }
  if (
    original.fragments.some((ref) =>
      ['xfield_identity', 'business_editorial'].includes(ref.slot ?? ''),
    )
  )
    throw new Error(`System layer slot collision: ${key}`);
  const converted = keyReferenceBody(original, fragments);
  const prefix = `{{fragment.xfield.identity}}\n\n{{fragment.${editorial}}}`;
  const prepend = (text: string | null) => (text ? `${prefix}\n\n${text}` : prefix);
  return validatePromptBody(key, 'request', {
    ...converted,
    systemInstructions:
      Object.keys(original.variants).length && original.systemInstructions === null
        ? null
        : prepend(converted.systemInstructions),
    variants: Object.fromEntries(
      Object.entries(converted.variants).map(([name, roles]) => [
        name,
        { ...roles, systemInstructions: prepend(roles.systemInstructions) },
      ]),
    ),
    fragments: [
      { key: 'xfield.identity', activeKey: 'xfield.identity' },
      { key: editorial, activeKey: editorial },
      ...converted.fragments,
    ],
  });
}
