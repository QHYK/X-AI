import { STAGE4_CONTEXT_DECISION_INSTRUCTIONS } from '../../prompts/stage4-context-decision.js';
/** Import-only bridge. B3.2 runtime must never depend on these static builders. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  buildStage1Instructions,
  STAGE1_PROMPT_VERSION,
} from '../../prompts/stage1-content-understanding.js';
import {
  buildStage2Instructions,
  STAGE2_PROMPT_VERSION,
} from '../../prompts/stage2-event-merge.js';
import {
  buildStage3EventRankingInstructions,
  STAGE3_EVENT_RANKING_PROMPT_VERSION,
} from '../../prompts/stage3-event-ranking.js';
import {
  buildStage3DigestRankingInstructions,
  STAGE3_DIGEST_RANKING_PROMPT_VERSION,
} from '../../prompts/stage3-digest-ranking.js';
import {
  buildStage3LongFormRankingInstructions,
  STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
} from '../../prompts/stage3-long-form-ranking.js';
import {
  buildStage4EventEnrichmentInstructions,
  STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
} from '../../prompts/stage4-event-enrichment.js';
import {
  buildDiscoveryD2Instructions,
  buildDiscoveryEditorialCriteria,
  DISCOVERY_D2_PROMPT_VERSION,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
} from '../../prompts/discovery-topic-selection.js';
import {
  buildDiscoveryD3Instructions,
  DISCOVERY_D3_PROMPT_VERSION,
} from '../../prompts/discovery-topic-agent.js';
import {
  buildDiscoveryD4Instructions,
  DISCOVERY_D4_PROMPT_VERSION,
} from '../../prompts/discovery-direct-verification.js';
import {
  buildDiscoveryD5Instructions,
  DISCOVERY_D5_PROMPT_VERSION,
} from '../../prompts/discovery-open-agent.js';
import { DISCOVERY_TAGS_INSTRUCTIONS } from '../../prompts/discovery-tags.js';
import {
  IN_DEPTH_INTRODUCTION_PROMPT,
  IN_DEPTH_INTRODUCTION_WRITING_INSTRUCTIONS,
  IN_DEPTH_INTRODUCTION_PROMPT_VERSION,
} from '../../prompts/in-depth-introduction.js';
import {
  buildManualInDepthInstructions,
  MANUAL_IN_DEPTH_PROMPT_VERSION,
} from '../../prompts/manual-in-depth.js';
import {
  DIGEST_PUT_BACK_PROMPT,
  DIGEST_PUT_BACK_PROMPT_VERSION,
} from '../../prompts/digest-put-back.js';
import { buildReadMoreInstructions, READ_MORE_PROMPT_VERSION } from '../../prompts/read-more.js';
import type { PromptBody, PromptKey, RegistryKey } from './contracts.js';
import { validatePromptBody } from './contracts.js';
import type { PromptSeed } from './registry.js';

export function baselineVersionId(key: RegistryKey): string {
  const hex = createHash('sha256').update(`x-ai-field:prompt-baseline:v1:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Read exactly the current literal array; do not evaluate source code or maintain a second copy. */
export function extractStage4DecisionInstructions(source: string): string {
  const file = ts.createSourceFile('stage4-llm.ts', source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'determineWhetherExternalContextIsNeeded',
  );
  if (!fn) throw new Error('Stage4 decision function not found.');
  if (
    /productionPrompt\(\s*['"]daily\.stage4\.external_context_decision['"]/.test(fn.getText(file))
  )
    return STAGE4_CONTEXT_DECISION_INSTRUCTIONS;
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'instructions') {
      const value = node.initializer;
      if (
        !ts.isCallExpression(value) ||
        !ts.isPropertyAccessExpression(value.expression) ||
        value.expression.name.text !== 'join' ||
        !ts.isArrayLiteralExpression(value.expression.expression) ||
        value.arguments.length !== 1 ||
        !ts.isStringLiteral(value.arguments[0]) ||
        value.arguments[0].text !== '\n'
      )
        throw new Error('Stage4 decision instructions changed; cannot guarantee exact import.');
      const elements = value.expression.expression.elements;
      if (!elements.every(ts.isStringLiteral))
        throw new Error('Decision instructions must be static literals.');
      found.push(elements.map((element) => (element as ts.StringLiteral).text).join('\n'));
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  if (
    !found.length &&
    fn.getText(file).includes("productionPrompt('daily.stage4.external_context_decision'")
  )
    return STAGE4_CONTEXT_DECISION_INSTRUCTIONS;
  if (found.length !== 1)
    throw new Error('Expected exactly one Stage4 decision instruction array.');
  return found[0];
}
export async function buildProductionPromptSeeds(sourceCommit: string): Promise<PromptSeed[]> {
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit))
    throw new Error('A full source Git commit is required.');
  const fragments = [
    {
      slot: 'editorial',
      key: 'shared.discovery.editorial_criteria',
      text: buildDiscoveryEditorialCriteria(),
      legacy: DISCOVERY_EDITORIAL_PROMPT_VERSION,
    },
    { slot: 'tags', key: 'shared.discovery.tags', text: DISCOVERY_TAGS_INSTRUCTIONS, legacy: null },
    {
      slot: 'writing',
      key: 'shared.introduction.writing',
      text: IN_DEPTH_INTRODUCTION_WRITING_INSTRUCTIONS,
      legacy: IN_DEPTH_INTRODUCTION_PROMPT_VERSION,
    },
  ] as const;
  const body = (
    systemInstructions: string | null,
    userTemplate: string | null = '{{input}}',
  ): PromptBody => ({ systemInstructions, userTemplate, variants: {}, fragments: [] });
  const common = (key: RegistryKey, kind: 'request' | 'fragment', legacy: string | null) => {
    const [workflow, step, ...request] = key.split('.');
    return {
      id: baselineVersionId(key),
      key,
      kind,
      workflow,
      step,
      requestType: request.join('.'),
      displayName: request
        .join(' / ')
        .replaceAll('_', ' ')
        .replace(/\b[a-z]/g, (c) => c.toUpperCase()),
      source: {
        sourceCommit,
        ...(legacy ? { legacyVersion: legacy } : {}),
        changeNote: 'B3.1 exact static baseline import; production callers unchanged.',
      },
    };
  };
  const seeds: PromptSeed[] = fragments.map((fragment) => ({
    ...common(fragment.key, 'fragment', fragment.legacy),
    body: body(fragment.text, null),
  }));
  const add = (
    key: PromptKey,
    text: string,
    legacy: string | null,
    slots: string[] = [],
    user = '{{input}}',
  ) => {
    const result = body(text, user);
    for (const slot of slots) {
      const fragment = fragments.find((f) => f.slot === slot)!;
      if (text.split(fragment.text).length !== 2)
        throw new Error(`Expected one exact ${slot} fragment in ${key}`);
      result.systemInstructions = result.systemInstructions!.replace(
        fragment.text,
        `{{fragment.${slot}}}`,
      );
      result.fragments.push({ slot, versionId: baselineVersionId(fragment.key) });
    }
    seeds.push({ ...common(key, 'request', legacy), body: result });
  };
  add('daily.stage1.content_understanding', buildStage1Instructions(), STAGE1_PROMPT_VERSION);
  add('daily.stage2.event_merge', buildStage2Instructions(), STAGE2_PROMPT_VERSION);
  add(
    'daily.stage3.event_ranking',
    buildStage3EventRankingInstructions(),
    STAGE3_EVENT_RANKING_PROMPT_VERSION,
  );
  add(
    'daily.stage3.digest_ranking',
    buildStage3DigestRankingInstructions('{{category}}'),
    STAGE3_DIGEST_RANKING_PROMPT_VERSION,
  );
  add(
    'daily.stage3.long_form_ranking',
    buildStage3LongFormRankingInstructions(),
    STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
  );
  add('daily.stage4.external_context_decision', STAGE4_CONTEXT_DECISION_INSTRUCTIONS, null);
  const enrichment: PromptSeed = {
    ...common('daily.stage4.event_enrichment', 'request', STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION),
    body: body(null, null),
  };
  enrichment.body.variants = {
    without_search: {
      systemInstructions: buildStage4EventEnrichmentInstructions({ webSearchAvailable: false }),
      userTemplate: '{{input}}',
    },
    with_search: {
      systemInstructions: buildStage4EventEnrichmentInstructions({ webSearchAvailable: true }),
      userTemplate: '{{input}}',
    },
  };
  seeds.push(enrichment);
  add('discovery.d2.topic_selection', buildDiscoveryD2Instructions(), DISCOVERY_D2_PROMPT_VERSION, [
    'editorial',
  ]);
  add('discovery.d3.topic_discovery', buildDiscoveryD3Instructions(), DISCOVERY_D3_PROMPT_VERSION, [
    'editorial',
    'tags',
  ]);
  add(
    'discovery.d4.direct_verification',
    buildDiscoveryD4Instructions(),
    DISCOVERY_D4_PROMPT_VERSION,
    ['editorial', 'tags'],
  );
  add('discovery.d5.open_discovery', buildDiscoveryD5Instructions(), DISCOVERY_D5_PROMPT_VERSION, [
    'editorial',
    'tags',
  ]);
  add(
    'in_depth.editorial.introduction',
    IN_DEPTH_INTRODUCTION_PROMPT,
    IN_DEPTH_INTRODUCTION_PROMPT_VERSION,
    ['writing'],
  );
  add(
    'in_depth.manual.generate',
    buildManualInDepthInstructions(),
    MANUAL_IN_DEPTH_PROMPT_VERSION,
    ['editorial', 'writing', 'tags'],
  );
  add('daily.editorial.digest_put_back', DIGEST_PUT_BACK_PROMPT, DIGEST_PUT_BACK_PROMPT_VERSION);
  add(
    'daily.read_more.detailed_summary',
    buildReadMoreInstructions(),
    READ_MORE_PROMPT_VERSION,
    [],
    'Article text:\n\n{{input}}',
  );
  for (const seed of seeds) validatePromptBody(seed.key, seed.kind, seed.body);
  return seeds;
}
