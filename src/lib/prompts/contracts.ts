import { z } from 'zod';
import { DIGEST_CATEGORY_KEYS } from '../daily-brief.js';

// Executable request identities and permitted inputs remain a code contract.
export const PROMPT_CONTRACTS = {
  'daily.stage1.content_understanding': {},
  'daily.stage2.event_merge': {},
  'daily.stage3.event_ranking': {},
  'daily.stage3.digest_ranking': { category: true },
  'daily.stage3.long_form_ranking': {},
  'daily.stage4.external_context_decision': {},
  'daily.stage4.event_enrichment': { variants: ['without_search', 'with_search'] },
  'discovery.d2.topic_selection': {},
  'discovery.d3.topic_discovery': {},
  'discovery.d4.direct_verification': {},
  'discovery.d5.open_discovery': {},
  'in_depth.editorial.introduction': {},
  'in_depth.manual.generate': {},
  'daily.editorial.digest_put_back': {},
  'daily.read_more.detailed_summary': {},
} satisfies Record<string, { category?: boolean; variants?: string[] }>;
export type PromptKey = keyof typeof PROMPT_CONTRACTS;
export const ACTIVE_FRAGMENT_KEYS = [
  'xfield.identity',
  'daily_brief.editorial',
  'discover.editorial',
] as const;
export type ActiveFragmentKey = (typeof ACTIVE_FRAGMENT_KEYS)[number];
export type SystemFragmentSnapshot = Record<ActiveFragmentKey, string>;
export const FRAGMENT_KEYS = [
  'shared.discovery.editorial_criteria',
  'shared.discovery.tags',
  'shared.introduction.writing',
  ...ACTIVE_FRAGMENT_KEYS,
] as const;
export type RegistryKey = PromptKey | (typeof FRAGMENT_KEYS)[number];
export type RegistryKind = 'request' | 'fragment';

const RoleText = z.string().nullable();
export const PromptBodySchema = z
  .object({
    systemInstructions: RoleText,
    userTemplate: RoleText,
    variants: z.record(
      z.string().regex(/^[a-z][a-z0-9_]*$/),
      z
        .object({
          systemInstructions: RoleText,
          userTemplate: RoleText,
        })
        .strict(),
    ),
    fragments: z.array(
      z
        .object({
          slot: z.string().regex(/^[a-z][a-z0-9_]*$/),
          versionId: z.uuid().optional(),
          activeKey: z.enum(ACTIVE_FRAGMENT_KEYS).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (body) => body.fragments.every((ref) => !!ref.versionId !== !!ref.activeKey),
    'Fragment requires exactly one versionId or activeKey.',
  );
export type PromptBody = z.infer<typeof PromptBodySchema>;
export type PromptVersion = {
  id: string;
  registryId: string;
  key: RegistryKey;
  kind: RegistryKind;
  version: number;
  status: 'draft' | 'published';
  body: PromptBody;
  contentHash: string;
  sourceCommit: string | null;
  legacyVersion: string | null;
  changeNote?: string | null;
};

export function contractFor(key: RegistryKey) {
  if (!Object.hasOwn(PROMPT_CONTRACTS, key)) throw new Error(`Unsupported request key: ${key}`);
  return PROMPT_CONTRACTS[key as PromptKey] as { category?: boolean; variants?: string[] };
}
function variables(text: string | null): string[] {
  if (!text) return [];
  const names = [...text.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g)].map((m) => m[1]);
  if (/\{\{|\}\}/.test(text.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, '')))
    throw new Error('Only simple {{variable}} substitutions are supported.');
  return names;
}
export function validatePromptBody(key: RegistryKey, kind: RegistryKind, raw: unknown): PromptBody {
  const body = PromptBodySchema.parse(raw);
  if (kind === 'fragment') {
    if (!(FRAGMENT_KEYS as readonly string[]).includes(key))
      throw new Error('Unknown fragment key.');
    if (body.fragments.length || Object.keys(body.variants).length || body.userTemplate !== null)
      throw new Error('Fragments cannot reference fragments, have variants or a User template.');
    if (variables(body.systemInstructions).length)
      throw new Error('Fragments must be literal text.');
    return body;
  }
  const contract = contractFor(key);
  const variantNames = Object.keys(body.variants).sort();
  if (JSON.stringify(variantNames) !== JSON.stringify([...(contract.variants ?? [])].sort()))
    throw new Error('Unsupported or missing named variants.');
  const slots = body.fragments.map((f) => f.slot);
  if (new Set(slots).size !== slots.length) throw new Error('Duplicate fragment slots.');
  const activeKeys = body.fragments.flatMap((ref) => (ref.activeKey ? [ref.activeKey] : []));
  if (new Set(activeKeys).size !== activeKeys.length)
    throw new Error('Duplicate active fragment references.');
  for (const roles of [body, ...Object.values(body.variants)]) {
    const system = variables(roles.systemInstructions);
    const user = variables(roles.userTemplate);
    if (system.some((v) => !v.startsWith('fragment.') && (v !== 'category' || !contract.category)))
      throw new Error('Unknown System variable; business input belongs in User.');
    if (user.some((v) => v !== 'input' && !(v === 'category' && contract.category)))
      throw new Error('Unknown User variable.');
    const referenced = system.filter((v) => v.startsWith('fragment.')).map((v) => v.slice(9));
    // Each populated System variant includes every shared fragment exactly once, in order.
    if (
      roles.systemInstructions !== null &&
      roles.systemInstructions.trim() &&
      JSON.stringify(referenced) !== JSON.stringify(slots)
    )
      throw new Error('Fragment placeholders must match the ordered references.');
  }
  return body;
}

export type RenderedPrompt = { instructions?: string; user?: string };
export function renderResolvedPrompt(
  version: PromptVersion,
  fragments: ReadonlyMap<string, PromptVersion>,
  values: { input: string; category?: string },
  variant?: string,
): RenderedPrompt {
  const body = validatePromptBody(version.key, version.kind, version.body);
  if (version.kind !== 'request' || version.status !== 'published')
    throw new Error('Only published requests can be rendered.');
  const contract = contractFor(version.key);
  const allowed = ['input', ...(contract.category ? ['category'] : [])];
  if (Object.keys(values).some((v) => !allowed.includes(v)))
    throw new Error('Unknown input variable.');
  if (typeof values.input !== 'string' || !values.input.trim())
    throw new Error('Missing business input.');
  if (contract.category && (!values.category || !values.category.trim()))
    throw new Error('Missing category.');
  if (contract.category && !(DIGEST_CATEGORY_KEYS as readonly string[]).includes(values.category!))
    throw new Error('Unsupported Digest category.');
  if (
    contract.variants ? !variant || !Object.hasOwn(body.variants, variant) : variant !== undefined
  )
    throw new Error('Unsupported or missing request variant.');
  const roles = variant ? body.variants[variant] : body;
  const literalFragments = new Map<string, string>();
  for (const ref of body.fragments) {
    const fragment = fragments.get(ref.versionId ?? ref.activeKey!);
    if (
      !fragment ||
      (ref.versionId ? fragment.id !== ref.versionId : fragment.key !== ref.activeKey) ||
      fragment.kind !== 'fragment' ||
      fragment.status !== 'published'
    )
      throw new Error(`Invalid published fragment: ${ref.versionId}`);
    validatePromptBody(fragment.key, fragment.kind, fragment.body);
    literalFragments.set(`fragment.${ref.slot}`, fragment.body.systemInstructions ?? '');
  }
  const render = (text: string | null) =>
    (text ?? '').replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, (_match, name: string) => {
      const value = literalFragments.get(name) ?? values[name as keyof typeof values];
      if (value === undefined) throw new Error(`Missing template variable: ${name}`);
      return value; // Single pass: webpage text is never recursively evaluated.
    });
  const instructions = render(roles.systemInstructions);
  let user = render(roles.userTemplate);
  if (!variables(roles.userTemplate).includes('input'))
    user = user.trim() ? `${user}\n\n${values.input}` : values.input;
  return {
    ...(instructions.trim() ? { instructions } : {}),
    ...(user.trim() ? { user } : {}),
  };
}

/** Explicit adapter preview; no production Client is changed or invoked. */
export function mapPromptRoles(
  prompt: RenderedPrompt,
  config: {
    api: 'chat_completions' | 'responses' | 'agent';
    provider: 'openai' | 'codex' | 'deepseek' | 'kimi';
  },
) {
  if (
    !['chat_completions', 'responses', 'agent'].includes(config.api) ||
    !['openai', 'codex', 'deepseek', 'kimi'].includes(config.provider)
  )
    throw new Error('Unsupported provider/API configuration.');
  if (config.api === 'agent' && config.provider !== 'codex')
    throw new Error('Current Discovery Agent integration requires Codex Responses.');
  if (config.api === 'responses' && !['openai', 'codex'].includes(config.provider))
    throw new Error('This provider cannot preserve Responses semantics.');
  const instructions = prompt.instructions?.trim() ? prompt.instructions : undefined;
  const user = prompt.user?.trim() ? prompt.user : undefined;
  if (config.api === 'chat_completions')
    return {
      messages: [
        ...(instructions ? [{ role: 'system' as const, content: instructions }] : []),
        ...(user ? [{ role: 'user' as const, content: user }] : []),
      ],
    };
  return { ...(instructions ? { instructions } : {}), ...(user ? { input: user } : {}) };
}
