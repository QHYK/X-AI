/** Offline rule proposals + comparison against saved human labels; never imports labels into rules. */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createReviewStore, type ReviewMessage } from './review-data.js';
import { saveJson } from '../../src/collectors/gmail/auth.js';
import { digest } from '../../src/collectors/gmail/preview.js';
import { SOURCE_RULE_VERSION } from '../../src/collectors/gmail/source-guided-selection.js';
const output = resolve('spikes/gmail/runtime/source-guided-v2');
const previousRoot = resolve('spikes/gmail/runtime/source-annotations');
const originalRoot = resolve('runtime/spikes/gmail/annotations');
const store = createReviewStore(undefined, {
  additionalRoot: resolve('spikes/gmail/runtime/validation'),
  annotationRoot: previousRoot,
  annotationFallbackRoot: originalRoot,
});
// Verify all original annotation files remain byte-for-byte unchanged throughout this operation.
const inputHashes = new Map<string, string>();
for (const root of [previousRoot, originalRoot])
  for (const file of await readdir(root))
    if (file.endsWith('.json'))
      inputHashes.set(join(root, file), digest(await readFile(join(root, file), 'utf8')));
const messages = await store.list();
async function summarize(message: ReviewMessage) {
  const d = await store.detail(message.gmail_message_id);
  await saveJson(join(output, `${message.gmail_message_id}.json`), {
    schema_version: 1,
    purpose: 'code_rules_not_human_ground_truth',
    gmail_message_id: message.gmail_message_id,
    source: message.source,
    subject: message.subject,
    baseline: d.baseline,
    ...d.guidance,
  });
  const human = d.annotations?.added_units ?? [];
  const comparisons = human
    .filter((u) => u.status !== 'unreviewed')
    .map((u) => {
      const a = u.boundary_references?.start.start_offset,
        b = u.boundary_references?.end.end_offset;
      const valid = d.baseline_matches && a != null && b != null && b > a;
      const matches = valid
        ? d.guidance.units
            .flatMap((auto) => {
              const overlap = Math.max(
                0,
                Math.min(b, auto.source_range.end_offset) -
                  Math.max(a, auto.source_range.start_offset),
              );
              return overlap
                ? [
                    {
                      id: auto.id,
                      title: auto.title,
                      type: auto.content_type,
                      human_coverage: overlap / (b - a),
                      auto_coverage:
                        overlap / (auto.source_range.end_offset - auto.source_range.start_offset),
                    },
                  ]
                : [];
            })
            .sort((x, y) => y.human_coverage - x.human_coverage)
        : [];
      const start = u.boundary_references?.start.excerpt ?? '';
      const explicitlyExcluded =
        /^(?:PRESENTED\s*BY|SPONSORED\b|A message from\s|RELATED COVERAGE|And Finally)/i.test(
          start,
        ) ||
        (u.source_guidance?.review_label === 'opening_title_pending' &&
          message.source === 'The Associated Press') ||
        u.source_guidance?.review_label === 'sponsor_region_pending';
      const duplicate =
        valid &&
        u.status === 'rejected' &&
        human.some(
          (v) =>
            v !== u &&
            v.status === 'accepted' &&
            (v.boundary_references?.start.start_offset ?? Infinity) <= a &&
            (v.boundary_references?.end.end_offset ?? -Infinity) >= b,
        );
      return {
        annotation_id: u.manual_id,
        status: u.status,
        title: u.corrections.title ?? null,
        type: u.content_type,
        verified_boundary: valid,
        new_rule_excludes: explicitlyExcluded,
        duplicate_rejected_under_accepted: duplicate,
        matches,
        title_matches: matches[0]?.title === (u.corrections.title ?? null),
        type_matches: matches[0]?.type === u.content_type,
      };
    });
  const units = d.guidance.units;
  return {
    id: message.gmail_message_id,
    source: message.source,
    subject: message.subject,
    template: d.guidance.template,
    units: units.length,
    types: {
      standalone: units.filter((u) => u.content_type === 'standalone_content').length,
      external: units.filter((u) => u.content_type === 'external_reference').length,
      non_content: units.filter((u) => u.content_type === 'non_content').length,
    },
    with_links: units.filter((u) => u.urls.length).length,
    with_resolved_targets: units.filter((u) => u.urls.some((l) => l.target_url)).length,
    with_primary_url: units.filter((u) => u.primary_url).length,
    no_link_units: units.filter((u) => !u.urls.length).map((u) => ({ id: u.id, title: u.title })),
    warnings: d.guidance.warnings,
    comparisons,
  };
}
const summaries: Awaited<ReturnType<typeof summarize>>[] = [];
for (const message of messages) summaries.push(await summarize(message));
for (const [path, hash] of inputHashes)
  if (digest(await readFile(path, 'utf8')) !== hash)
    throw new Error(
      'Human annotations changed during comparison; no reliable comparison report produced',
    );
const comparisons = summaries.flatMap((m) =>
  m.comparisons.map((c) => ({ ...c, source: m.source, message_id: m.id, subject: m.subject })),
);
const bySource = [...new Set(summaries.map((m) => m.source))].sort().map((source) => {
  const rows = summaries.filter((m) => m.source === source);
  return {
    source,
    messages: rows.length,
    units: rows.reduce((n, m) => n + m.units, 0),
    with_links: rows.reduce((n, m) => n + m.with_links, 0),
    with_resolved_targets: rows.reduce((n, m) => n + m.with_resolved_targets, 0),
    with_primary_url: rows.reduce((n, m) => n + m.with_primary_url, 0),
    non_content: rows.reduce((n, m) => n + m.types.non_content, 0),
  };
});
const accepted = comparisons.filter((c) => c.status === 'accepted');
const superseded = accepted.filter((c) => c.new_rule_excludes);
const activeAccepted = accepted.filter((c) => !c.new_rule_excludes);
const report = {
  rule_version: SOURCE_RULE_VERSION,
  messages: summaries.length,
  units: summaries.reduce((n, m) => n + m.units, 0),
  by_source: bySource,
  comparison: {
    annotated_messages: summaries.filter((m) => m.comparisons.length).length,
    accepted: accepted.length,
    accepted_excluded_by_latest_rule: superseded.length,
    accepted_remaining: activeAccepted.length,
    remaining_with_90pct_boundary_overlap: activeAccepted.filter(
      (c) => (c.matches[0]?.human_coverage ?? 0) >= 0.9,
    ).length,
    remaining_without_overlap: activeAccepted.filter((c) => !c.matches.length).length,
    rejected: comparisons.filter((c) => c.status === 'rejected').length,
    rejected_with_overlap: comparisons.filter(
      (c) => c.status === 'rejected' && c.matches.length && !c.duplicate_rejected_under_accepted,
    ).length,
    uncertain: comparisons.filter((c) => c.status === 'uncertain').length,
  },
  annotation_files_unchanged: inputHashes.size,
  results: summaries,
};
await saveJson(join(output, 'comparison.json'), report);
const lines = [
  '# Newsletter 来源规则 v2：离线对照',
  '',
  `邮件 ${report.messages}；自动单元 ${report.units}；原人工标注文件 ${inputHashes.size} 份哈希保持不变。`,
  '',
  '## 各来源与链接覆盖',
  '',
  '| 来源 | 邮件 | 单元 | 含链接 | 可静态解析目标 | 可确定主要 URL | non_content |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...bySource.map(
    (r) =>
      `| ${r.source} | ${r.messages} | ${r.units} | ${r.with_links} | ${r.with_resolved_targets} | ${r.with_primary_url} | ${r.non_content} |`,
  ),
  '',
  '## 与人工结果的对照',
  '',
  '```json',
  JSON.stringify(report.comparison, null, 2),
  '```',
  '',
  '边界重叠仅是结构证据，不是 Precision/Recall，也不能证明语义正确或边界完全相同。旧 accepted 赞助内容按最新明确规则排除；标题和 PRODUCTIVITY 类型更新可与旧标注不同。被 accepted 合并区域包含的旧 rejected 重复项不视为独立被拒内容。未审核项不视为负例。',
  '',
  '## 仍有差异或待确认',
  '',
  ...comparisons
    .filter(
      (c) =>
        !c.new_rule_excludes &&
        !c.duplicate_rejected_under_accepted &&
        ((c.status === 'accepted' &&
          ((c.matches[0]?.human_coverage ?? 0) < 0.9 || !c.title_matches || !c.type_matches)) ||
          (c.status === 'rejected' && c.matches.length)),
    )
    .map(
      (c) =>
        `- ${c.source} / ${c.message_id} / ${c.status} / ${c.title ?? '[无标题]'}：覆盖=${(c.matches[0]?.human_coverage ?? 0).toFixed(3)}；标题一致=${c.title_matches}；类型一致=${c.type_matches}。`,
    ),
  '',
  '## 缺少链接的模块',
  '',
  ...summaries.flatMap((m) =>
    m.no_link_units.map((u) => `- ${m.source} / ${m.id} / ${u.title ?? '[无标题]'}`),
  ),
  '',
  '## 规则与限制',
  '',
  '- Information Briefing 首段取首句；AM 数字版排除全部 A message from，Editor’s Pick 从问候后的正文至 Follow us，Weekend 至首个 h2，订阅广告不产出。',
  '- Reuters 按 h2 和正文 h3 分块；短封面与后续 h3 正文合并；实质 Top News 不并入 Business；保留阅读 CTA，And Finally 起排除。Beacon、Weekend 结构显式识别，尚未审核的新增模块不自动标负。',
  '- AP 忽略无题开场、RELATED COVERAGE、US NEWS；保留的栏目均为 standalone_content。',
  '- Superhuman 按 h5 / h4 与栏目组合识别日刊、Robotics、Science；所有 PRESENTED BY / SPONSORED 块排除，PRODUCTIVITY / NEW TECH 保存为 non_content。',
  '- Daily Upside 包含 Written by；无 MARKETS 的专题版仍按显式标题与署名配对，不把赞助开场当文章。',
  '- 链接来自原始锚点，包括包住标题的外层 a 和阅读 CTA；不请求重定向。Opaque tracking 可能无法静态解析，多条新闻模块不猜测唯一主 URL。',
  '- 右侧区域链接选择器按当前起终点筛选原始链接；选择后写入原有 Original URL 字段，允许手填；邮件预览不允许打开链接。',
];
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(join(output, 'comparison.md'), lines.join('\n') + '\n', { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      output,
      messages: report.messages,
      units: report.units,
      by_source: bySource,
      comparison: report.comparison,
      annotation_files_unchanged: inputHashes.size,
    },
    null,
    2,
  ),
);
