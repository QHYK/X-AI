/** Initialization only. Production Runtime must not import this module or its frozen baseline. */
import { createHash } from 'node:crypto';
import baseline from './seed-baseline.json' with { type: 'json' };
import { validatePromptBody, type RegistryKey } from './contracts.js';
import type { PromptSeed } from './registry.js';

export function baselineVersionId(key: RegistryKey): string {
  const hex = createHash('sha256').update(`x-ai-field:prompt-baseline:v1:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function buildProductionPromptSeeds(sourceCommit: string): Promise<PromptSeed[]> {
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit))
    throw new Error('A full source Git commit is required.');
  const seeds = structuredClone(baseline.seeds) as PromptSeed[];
  for (const seed of seeds) {
    validatePromptBody(seed.key, seed.kind, seed.body);
    if (seed.id !== baselineVersionId(seed.key)) throw new Error('Invalid baseline Version ID.');
    seed.source.sourceCommit = sourceCommit;
  }
  return seeds;
}
