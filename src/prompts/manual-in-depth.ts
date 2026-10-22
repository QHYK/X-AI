import { IN_DEPTH_INTRODUCTION_WRITING_INSTRUCTIONS } from './in-depth-introduction.js';
import { buildDiscoveryEditorialCriteria } from './discovery-topic-selection.js';
import { DISCOVERY_TAGS_INSTRUCTIONS } from './discovery-tags.js';

export const MANUAL_IN_DEPTH_PROMPT_VERSION = 'v1';
export function buildManualInDepthInstructions(): string {
  return `${buildDiscoveryEditorialCriteria()}

${IN_DEPTH_INTRODUCTION_WRITING_INSTRUCTIONS}

${DISCOVERY_TAGS_INSTRUCTIONS}

本次是人工编辑已经初选的固定 URL 作品，不进行 qualified / rejected / unverifiable 入选判断，不搜索、不发现新候选、不生成时长或作者。请另外生成 title_zh，忠实自然地翻译实际原始标题。已有人工 Tags 作为上下文，不改变其含义。
只返回 title_zh、summary、whyWorthReading、extra_info、tags 五个字段。若正文不足，summary 和 whyWorthReading 返回空字符串，在 extra_info 说明限制；应用将明确失败，不保存成完整介绍。`;
}
