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
  seeds.push({
    id: baselineVersionId('daily.stage3.event_digest_consolidation'),
    key: 'daily.stage3.event_digest_consolidation',
    kind: 'request',
    workflow: 'Daily',
    step: 'Stage 3',
    requestType: 'event_digest_consolidation',
    displayName: 'Event–Digest Consolidation',
    body: {
      systemInstructions: `识别当前分类 Digest 中属于输入 Top 15 Event Groups 同一具体事件的报道。只在明确为同一次事件时匹配。
同一次公司财报公告的报道可以匹配；财报后的独立分析、行业趋势研究、长期观点必须保留 Digest。同一公司但不同事件不得匹配。优先保证准确性，不为了减少 Digest 数量扩大匹配范围；不确定时不匹配。
仅返回需要转入 Event 的 matches，每项包含 event_group_id 和 digest_content_ids。所有 ID 必须来自本次输入，每篇 Digest 只能分配一次。未匹配文章无需返回，没有匹配时 matches 为 []。严格遵循 Structured Output Schema，仅返回 JSON。`,
      userTemplate: '{{input}}',
      variants: {},
      fragments: [],
    },
    source: {
      legacyVersion: 'v1',
      changeNote: 'Initial Stage3 consolidation Request; import explicitly before use.',
    },
  });
  for (const seed of seeds) {
    validatePromptBody(seed.key, seed.kind, seed.body);
    if (seed.id !== baselineVersionId(seed.key)) throw new Error('Invalid baseline Version ID.');
    seed.source.sourceCommit = sourceCommit;
  }
  return seeds;
}
