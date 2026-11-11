/** Offline, read-only input export. Never import Collector/auth or write annotations. */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { digest } from '../../src/collectors/gmail/preview.js';
import { inspectUrl, plainAlternativeTarget } from '../../src/collectors/gmail/link-tools.js';
import type { Annotation, SavedUnit } from './review-data.js';
import type { GuidedUnit } from '../../src/collectors/gmail/source-guided-selection.js';

const knownSources = new Set([
  'The Information Briefing',
  'Reuters Daily Briefing',
  'The Associated Press',
  'The Information AM',
  'Superhuman – Zain Kahn',
  'The Daily Upside',
  'Reuters One Essential Read',
]);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const tracker =
  /(^|\.)(?:newslink\.reuters\.com|link\.apnews\.com|customeriomail\.com|beehiiv(?:status)?\.com|cmail\d*\.com|sng\.link)$|^url\d*\./i;
export function sanitizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    if (tracker.test(u.hostname) || /\/ls\/click|\/ss\/c\/|\/click\//.test(u.pathname))
      return `${u.origin}/[tracking-path-redacted]`;
    u.pathname = u.pathname
      .split('/')
      .map((p) =>
        /^(?:aHR0c|eyJ)/.test(p) ||
        (/[A-Z]/.test(p) && /\d/.test(p) && /^[A-Za-z0-9_=]{48,}$/.test(p)) ||
        /^[a-f\d]{24,}$/i.test(p)
          ? '[identifier-redacted]'
          : p,
      )
      .join('/');
    return u.toString();
  } catch {
    return null;
  }
}
export function createRedactor(privateNames: string[] = []) {
  return (input: string) => {
    let s = input.replace(/https?:\/\/[^\s<>"`]+/gi, (url) => sanitizeUrl(url) ?? '[url-omitted]');
    s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]');
    for (const name of privateNames.filter((n) => n.length >= 3))
      s = s.replace(
        new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        '[recipient-redacted]',
      );
    s = s.replace(/\b(?:authorization|cookie)\s*[:=][^\n]+/gi, '[sensitive-header-redacted]');
    s = s.replace(
      /\b(?:access_token|refresh_token|client_secret|authorization|cookie|subscription_token|user_email|lctg)\s*[:=]\s*[^\s,;]+/gi,
      '[sensitive-value-redacted]',
    );
    s = s.replace(
      /\b\d{1,6}\s+[A-Za-z][A-Za-z .]{0,45}\b(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.)\s*(?:Suite\s*\d+)?/g,
      '[postal-address-redacted]',
    );
    s = s.replace(/\+\d[\d ()-]{9,}\d\b/g, '[phone-redacted]');
    return s;
  };
}
const statuses = () => ({ accepted: 0, rejected: 0, uncertain: 0, unreviewed: 0 });
function count<T>(values: T[], key: (v: T) => string) {
  const result: Record<string, number> = {};
  for (const v of values) {
    const k = key(v);
    result[k] = (result[k] ?? 0) + 1;
  }
  return result;
}
const fieldNames = ['title', 'summary', 'original_url'] as const;
const md = (s: string) =>
  s.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/[\\`*_\[\]!#|]/g, '\\$&');

export async function exportAnnotations(
  root = resolve('runtime/spikes/gmail'),
  output = join(root, 'export'),
  guidanceRoot = resolve('spikes/gmail/runtime/source-guided'),
) {
  const inputHashes: Record<string, string> = {};
  const remember = async (file: string) => {
    const s = await readFile(file, 'utf8');
    inputHashes[file] = digest(s);
    return s;
  };
  const optionalJson = async <T>(file: string): Promise<T | null> => {
    try {
      return JSON.parse(await remember(file)) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const files = (await readdir(join(root, 'parsed')))
    .filter((f) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(f))
    .sort();
  const messages = [];
  const skipped: string[] = [];
  for (const file of files) {
    const m = JSON.parse(await remember(join(root, 'parsed', file)));
    const source = String(m.from?.[0]?.name ?? '');
    if (!knownSources.has(source)) {
      skipped.push(file);
      continue;
    }
    const id = String(m.gmailMessageId);
    if (file !== `${id}.json` || typeof m.html !== 'string') throw Error('Invalid local sample');
    const privateNames = (m.to ?? []).flatMap((p: { name?: string; address?: string }) => [
      p.name ?? '',
      p.address ?? '',
    ]);
    const redact = createRedactor(privateNames);
    const annPath = join(root, 'annotations', file);
    const annotation = await optionalJson<Annotation>(annPath);
    const guided = await optionalJson<{ units: GuidedUnit[] }>(join(guidanceRoot, file));
    const dom = new JSDOM(m.html, { includeNodeLocations: true });
    const doc = dom.window.document;
    try {
      const paragraphs = (a: number, b: number) => {
        const parts: { element: Element | null; text: string }[] = [];
        const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode,
            loc = dom.nodeLocation(n);
          const parent = n.parentElement;
          if (
            !loc ||
            loc.startOffset < a ||
            loc.endOffset > b ||
            !parent ||
            parent.closest('script,style,noscript,[hidden],[aria-hidden="true"]')
          )
            continue;
          let hidden = false;
          for (let p: Element | null = parent; p; p = p.parentElement)
            if (/display:\s*none|mso-hide:\s*all/i.test(p.getAttribute('style') ?? ''))
              hidden = true;
          if (hidden) continue;
          const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,td,div,blockquote');
          if (parts.at(-1)?.element === block) parts.at(-1)!.text += ' ' + n.textContent;
          else parts.push({ element: block, text: n.textContent ?? '' });
        }
        return parts.map((p) => clean(p.text)).filter(Boolean);
      };
      function nodeFromPath(path: number[]) {
        let n: Node = doc;
        for (const index of path) {
          const child = n.childNodes[index];
          if (!child) return null;
          n = child;
        }
        return n;
      }
      function links(a: number, b: number) {
        return Array.from(doc.querySelectorAll('a[href]'))
          .filter((e) => {
            const l = dom.nodeLocation(e);
            return l && l.startOffset >= a && l.endOffset <= b;
          })
          .map((e) => {
            const u = inspectUrl(e.getAttribute('href') ?? '');
            if (!u) return null;
            const plain = !u.target_url
              ? plainAlternativeTarget(m.plainText ?? '', clean(e.textContent))
              : null;
            return {
              anchor_text: redact(clean(e.textContent)),
              original_url: sanitizeUrl(u.original_url),
              target_url: sanitizeUrl(u.target_url ?? plain?.url ?? ''),
              target_evidence: u.target_url
                ? u.static_resolution
                : plain
                  ? 'plain_alternative_not_network_verified'
                  : 'unknown',
            };
          })
          .filter((x) => x !== null);
      }
      function extraction(unit: SavedUnit | null) {
        const refs = unit?.boundary_references;
        if (refs && annotation?.source.html_sha256 === digest(m.html)) {
          const start = nodeFromPath(refs.start.node_path),
            end = nodeFromPath(refs.end.node_path);
          const a = refs.start.start_offset,
            b = refs.end.end_offset;
          if (
            start &&
            end &&
            digest(clean(start.textContent)) === refs.start.text_sha256 &&
            digest(clean(end.textContent)) === refs.end.text_sha256 &&
            a !== null &&
            b !== null &&
            a < b
          ) {
            return {
              trace: 'verified_saved_boundary',
              start_offset: a,
              end_offset: b,
              paragraphs: paragraphs(a, b),
              links: links(a, b),
            };
          }
        }
        if (
          unit?.text_evidence?.trim() &&
          clean(doc.body.textContent).includes(clean(unit.text_evidence))
        )
          return {
            trace: 'verified_text_quote_without_boundary',
            start_offset: null,
            end_offset: null,
            paragraphs: [unit.text_evidence],
            links: [],
          };
        return {
          trace: unit?.boundary ? 'unresolved_saved_boundary' : 'diagnostic_excerpt_only',
          start_offset: null,
          end_offset: null,
          paragraphs: [],
          links: [],
        };
      }
      const entries = (annotation?.added_units ?? []).map((unit) => ({
        unit,
        origin: unit.source_guidance ? 'source_guided' : 'manual',
      }));
      const units = entries.map(({ unit, origin }) => {
        const unitId = unit.manual_id!;
        const legacy = id === '1a19ef081b3523db' && origin !== 'source_guided';
        const proposal =
          (guided?.units ?? []).find((p) => p.id === unitId) ??
          (guided?.units ?? [])
            .filter(
              (p) =>
                p.review_label === unit?.source_guidance?.review_label &&
                p.title === unit?.corrections.title,
            )
            .filter((_, i, arr) => arr.length === 1 && i === 0)[0] ??
          null;
        const baseline = proposal
          ? {
              title: proposal.title,
              summary: null,
              original_url: proposal.title
                ? (proposal.urls.find((l) => l.anchor_text === proposal.title)?.target_url ??
                  proposal.urls.find((l) => l.anchor_text === proposal.title)?.original_url ??
                  null)
                : null,
            }
          : null;
        const result = extraction(unit);
        const effective = {
          title:
            unit?.corrections.title !== undefined
              ? unit.corrections.title
              : (proposal?.title ?? null),
          summary: unit?.corrections.summary !== undefined ? unit.corrections.summary : null,
          original_url:
            unit?.corrections.original_url !== undefined
              ? unit.corrections.original_url
              : (baseline?.original_url ?? null),
        };
        const changes = Object.fromEntries(
          fieldNames.map((k) => [
            k,
            unit && Object.hasOwn(unit.corrections, k)
              ? baseline
                ? (clean(unit.corrections[k]) || null) !== (clean(baseline[k]) || null)
                : 'baseline_unavailable'
              : false,
          ]),
        );
        return {
          unit_id: unitId,
          manual_id: unit?.manual_id ?? null,
          origin,
          analysis_scope: legacy ? 'excluded_legacy_interaction' : 'current',
          annotation_present: !!unit,
          status: unit?.status ?? 'unreviewed',
          content_type: unit?.content_type ?? null,
          source_guidance: unit?.source_guidance ?? null,
          comparison_baseline: baseline
            ? {
                kind: 'current_source_proposal_not_initial_history',
                title: baseline.title ? redact(baseline.title) : null,
                summary: baseline.summary ? redact(baseline.summary) : null,
                original_url: sanitizeUrl(baseline.original_url ?? ''),
              }
            : null,
          corrections: unit
            ? Object.fromEntries(
                fieldNames
                  .filter((k) => Object.hasOwn(unit.corrections, k))
                  .map((k) => [
                    k,
                    k === 'original_url'
                      ? sanitizeUrl(unit.corrections[k] ?? '')
                      : unit.corrections[k] === null
                        ? null
                        : redact(unit.corrections[k] ?? ''),
                  ]),
              )
            : {},
          effective: {
            title: effective.title ? redact(effective.title) : null,
            summary: effective.summary ? redact(effective.summary) : null,
            original_url: sanitizeUrl(effective.original_url ?? ''),
          },
          field_differences_vs_available_baseline: changes,
          boundary_difference_vs_current_proposal:
            unit?.boundary && proposal
              ? JSON.stringify(unit.boundary) !== JSON.stringify(proposal.boundary)
              : null,
          boundary: unit?.boundary ?? null,
          boundary_references: unit?.boundary_references
            ? {
                start: {
                  ...unit.boundary_references.start,
                  excerpt: redact(unit.boundary_references.start.excerpt),
                },
                end: {
                  ...unit.boundary_references.end,
                  excerpt: redact(unit.boundary_references.end.excerpt),
                },
              }
            : null,
          text_evidence: unit?.text_evidence ? redact(unit.text_evidence) : null,
          notes: redact(unit?.notes ?? ''),
          source_trace: result.trace,
          source_range: {
            html_sha256: digest(m.html),
            start_offset: result.start_offset,
            end_offset: result.end_offset,
            offset_unit: 'UTF-16 code units',
          },
          original_paragraphs: result.paragraphs.map(redact),
          links: result.links,
          preliminary_review: null as null | Record<string, unknown>,
        };
      });
      const headings = Array.from(doc.querySelectorAll('h2,h3,h4,h5'))
        .map((e) => ({
          title: redact(clean(e.textContent)),
          offset: dom.nodeLocation(e)?.startOffset ?? -1,
        }))
        .filter((h) => h.offset >= 0);
      for (const u of units.filter((u) => u.status === 'uncertain')) {
        const label = u.source_guidance?.review_label ?? '';
        const title = u.effective.title ?? u.comparison_baseline?.title ?? '';
        const kind =
          label === 'mixed_section_pending'
            ? 'multi_item_business_roundup'
            : /In Other News/i.test(title)
              ? 'multi_item_news_roundup'
              : /TODAY IN AI|trending on socials/i.test(title)
                ? 'multi_item_ai_news_roundup'
                : label === 'superhuman_title_pending'
                  ? 'tool_or_product_link_collection'
                  : 'unknown';
        const following = units.filter(
          (v) =>
            v.status === 'accepted' &&
            v.analysis_scope === 'current' &&
            v.source_range.start_offset !== null &&
            u.source_range.end_offset !== null &&
            v.source_range.start_offset >= u.source_range.end_offset,
        );
        const targetSet = new Set(
          u.links.map((l) => l!.target_url).filter((url) => url && !url.includes('redacted')),
        );
        const overlaps = following.filter((v) =>
          v.links.some((l) => l!.target_url && targetSet.has(l.target_url)),
        );
        const a = u.source_range.start_offset,
          b = u.source_range.end_offset;
        u.preliminary_review = {
          classification: kind,
          classification_basis:
            'section label, heading and list/link structure only; not semantic classification',
          previous_heading:
            a === null ? null : (headings.filter((h) => h.offset < a).at(-1) ?? null),
          next_heading: b === null ? null : (headings.find((h) => h.offset >= b) ?? null),
          previous_paragraph: a === null ? null : redact(paragraphs(0, a).at(-1) ?? ''),
          next_paragraph: b === null ? null : redact(paragraphs(b, m.html.length)[0] ?? ''),
          following_accepted_units: following.map((v) => ({
            unit_id: v.unit_id,
            title: v.effective.title,
          })),
          shared_targets_with_following_accepted_units: overlaps.map((v) => v.unit_id),
          only_summarizes_following_items: 'unknown',
          information_not_covered_by_following_items: 'unknown',
          independent_analysis_or_cross_event_links: 'unknown',
          independent_xfield_value: 'requires_human_judgment',
          evidence_limit:
            'Only exact exposed URL overlap was checked; absent overlap does not prove different information. Opaque tracking URLs cannot be compared reliably. No LLM or network used.',
        };
      }
      messages.push({
        gmail_message_id: id,
        source,
        subject: redact(String(m.subject ?? '')),
        received_at: m.receivedAt ?? null,
        received_date_shanghai: m.receivedAt
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(m.receivedAt))
          : null,
        date_header: redact(String(m.dateHeader ?? '')),
        annotation_file_present: !!annotation,
        annotation_updated_at: annotation?.updated_at ?? null,
        html_baseline_matches: annotation ? annotation.source.html_sha256 === digest(m.html) : null,
        units,
      });
    } finally {
      dom.window.close();
    }
  }
  const raw = messages.flatMap((m) => m.units),
    current = raw.filter((u) => u.analysis_scope === 'current'),
    added = current;
  const summary = {
    messages: messages.length,
    sources: new Set(messages.map((m) => m.source)).size,
    annotated_messages: messages.filter((m) => m.annotation_file_present).length,
    unannotated_message_ids: messages
      .filter((m) => !m.annotation_file_present)
      .map((m) => m.gmail_message_id),
    raw_status_counts: { ...statuses(), ...count(raw, (u) => u.status) },
    current_status_counts: { ...statuses(), ...count(current, (u) => u.status) },
    current_added_status_counts: { ...statuses(), ...count(added, (u) => u.status) },
    raw_added_units: raw.length,
    source_guided_units: current.filter((u) => u.origin === 'source_guided').length,
    true_manual_units: current.filter((u) => u.origin === 'manual').length,
    excluded_legacy_units: raw.length - current.length,
    accepted_content_types: count(
      current.filter((u) => u.status === 'accepted'),
      (u) => u.content_type ?? 'unspecified',
    ),
    uncertain_content_types: count(
      current.filter((u) => u.status === 'uncertain'),
      (u) => u.content_type ?? 'unspecified',
    ),
    accepted_safe_original_url_count: current.filter(
      (u) =>
        u.status === 'accepted' &&
        u.effective.original_url &&
        !u.effective.original_url.includes('redacted'),
    ).length,
    accepted_with_any_exposed_target_link: current.filter(
      (u) =>
        u.status === 'accepted' &&
        u.links.some((l) => l.target_url && !l.target_url.includes('redacted')),
    ).length,
    reviewed_or_uncertain_without_verified_text: current
      .filter((u) => u.status !== 'unreviewed' && !u.source_trace.startsWith('verified'))
      .map((u) => u.unit_id),
    accepted_field_completeness: Object.fromEntries(
      fieldNames.map((k) => [
        k,
        current.filter((u) => u.status === 'accepted' && !!u.effective[k]).length,
      ]),
    ),
    correction_fields_present: Object.fromEntries(
      fieldNames.map((k) => [
        k,
        current.filter((u) => u.annotation_present && Object.hasOwn(u.corrections, k)).length,
      ]),
    ),
    field_differences_vs_available_baseline: Object.fromEntries(
      fieldNames.map((k) => [
        k,
        current.filter((u) => u.field_differences_vs_available_baseline[k] === true).length,
      ]),
    ),
    field_comparison_unknown: Object.fromEntries(
      fieldNames.map((k) => [
        k,
        current.filter(
          (u) => u.field_differences_vs_available_baseline[k] === 'baseline_unavailable',
        ).length,
      ]),
    ),
    boundary_differences_vs_current_proposal: current.filter(
      (u) => u.boundary_difference_vs_current_proposal === true,
    ).length,
    unresolved_saved_boundaries: current
      .filter((u) => u.source_trace === 'unresolved_saved_boundary')
      .map((u) => u.unit_id),
    boundary_verified_annotated_units: current.filter(
      (u) => u.annotation_present && u.source_trace === 'verified_saved_boundary',
    ).length,
    uncertain_kinds: count(
      current.filter((u) => u.status === 'uncertain'),
      (u) => String(u.preliminary_review?.classification ?? 'unknown'),
    ),
  };
  const exported = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    scope: 'local newsletter samples only; no OAuth/raw MIME/HTML/envelope exported',
    methodology: [
      'Counts cover source-guided selections and explicit human additions only.',
      'Only source-guided selections and human additions are exported; retired heuristic splits are excluded.',
      'Source-guided units are not evidence of parser misses. Unreviewed is not rejected. No Precision/Recall can be inferred.',
      'Field differences are against available snapshots/current proposals, not a complete edit history; prefilled fields are not necessarily human corrections.',
      'Public article/author names remain; recipients, email addresses, URL queries/fragments and tracking paths are redacted. Further manual privacy review is required before external sharing.',
    ],
    summary,
    skipped_unknown_source_files: skipped,
    messages,
  };
  const report = renderReport(exported);
  // Verify the entire read set before writing export artifacts only.
  for (const [path, hash] of Object.entries(inputHashes))
    if (digest(await readFile(path, 'utf8')) !== hash)
      throw Error('Input changed during export; retry after saving finishes');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, 'newsletter-annotations-export.json'),
    JSON.stringify(exported, null, 2) + '\n',
    { mode: 0o600 },
  );
  await writeFile(join(output, 'newsletter-annotation-review.md'), report, { mode: 0o600 });
  return { summary, output, input_files_verified: Object.keys(inputHashes).length };
}

function renderReport(data: {
  exported_at: string;
  summary: { [key: string]: unknown };
  messages: {
    gmail_message_id: string;
    source: string;
    subject: string;
    received_at: string | null;
    annotation_file_present: boolean;
    units: { [key: string]: unknown }[];
  }[];
}) {
  // The JSON is authoritative for machine-readable details. Markdown mirrors all uncertain entries without truncation.
  const lines = [
    '# Newsletter 人工标注评审导出',
    '',
    `导出时间：${data.exported_at}（UTC）。邮件 received_at 保留原始 ISO 时间，日期归属以 Asia/Shanghai 阅读。`,
    '',
    '## A. 标注完成情况',
    '',
    '```json\n' + JSON.stringify(data.summary, null, 2) + '\n```',
    '',
    '### 统计口径与限制',
    '- raw_status_counts 是全部记录的原始统计；current_status_counts 排除用户已明确废弃的第一封 Information Briefing 旧操作。没有删除原文件。',
    '- current_added_status_counts 是来源预选/人工新增轨道。不能与旧启发式候选相加当作独立文章数，两个轨道有重叠。',
    '- 大多数 added_units 是来源预选，不能当作算法漏检数量；未审核不等于拒绝，不能计算 Precision/Recall。',
    '- corrections 字段常被 UI 预填。字段存在数不等于人工编辑数。差异数仅针对当前可获得的基线，初版来源预选未完整保存，历史编辑总数不可精确恢复。',
    '- boundary_differences_vs_current_proposal 同样不是完整历史修改次数；已被后续规则吸收的修正可能不再表现为差异。',
    '- 自动备注中的“待人工确认”可能过时，实际 status 和人工字段是准据。',
    '',
    '## B. 各来源结果',
    '',
    '| 来源 | 邮件/已保存 | 来源预选/手工新增 | accepted | rejected | uncertain | unreviewed |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  const sourceNotes: Record<string, string> = {
    'The Information Briefing':
      '【事实】只用第一封的来源预选作有效参考。开头无 h3 的完整正文可保留，记者推荐是外部链接；In Other News 尚待判断。【初步判断】栏目规则可帮助定位，但样本仅一封且正文综合区未解决。',
    'Reuters Daily Briefing':
      '【事实】完整叙述保留；一个 h3 被人工改成 standalone_content，只有栏目标题/图片署名的块被拒绝。In other news 与 Business & Markets 待判断。【判断】不能按 h2/h3 硬编码类型，规则定位之后仍有语义边界问题。',
    'The Associated Press':
      '【事实】正文被接受，作者开场导语与 RELATED COVERAGE 被拒绝，US NEWS 按来源规则排除。table/span 组织标题，不能依赖 h 标签。【判断】适合来源适配器；未逐一审核所有原始启发式候选，不能量化漏检。',
    'The Information AM':
      '【事实】编号简讯为正文，Popular articles 为外部推荐，PwC 正文保留但节目推广排除。【判断】编号/栏目/标题结构适合薄适配器，赞助标签不能一概视为非内容。',
    'Superhuman – Zain Kahn':
      '【事实】以 h5 分块、h2 作标题，PROMPT STATION 起不保留。SOFTR/RIPPLING/THE CODE 被拒绝，WORKOS 在保存标注中也被拒绝，但其他赞助栏目有接受记录。TODAY IN AI / IN THE KNOW / PRODUCTIVITY 仍有 uncertain。【判断】先结构分块，再研究合集和工具列表的内容单位，不把所有 PRESENTED BY 一概删除。',
    'The Daily Upside':
      '【事实】三封各三篇正文被接受；人工边界包含 Written by 署名，正文 h3 不拆篇；行情与间插推广排除。【判断】标题/署名边界适合来源适配器；三封不能证明长期模板稳定。',
    'Reuters One Essential Read':
      '【事实】h2 到 Read the full article 按钮之前为一个正文单元。【判断】单封不足以验证模板稳定或特殊情况。',
  };
  for (const source of new Set(data.messages.map((m) => m.source))) {
    const ms = data.messages.filter((m) => m.source === source);
    const us = ms.flatMap((m) => m.units).filter((u) => u.analysis_scope === 'current');
    const ads = us;
    const cs = count(ads, (u) => String(u.status));
    lines.push(
      `| ${md(source)} | ${ms.length}/${ms.filter((m) => m.annotation_file_present).length} | ${ads.length} | ${cs.accepted ?? 0} | ${cs.rejected ?? 0} | ${cs.uncertain ?? 0} | ${cs.unreviewed ?? 0} |`,
    );
  }
  lines.push('', '表中状态是“来源预选/手工新增”轨道；原始启发式轨道及所有状态详见 JSON。');
  for (const source of new Set(data.messages.map((m) => m.source)))
    lines.push('', `### ${source}`, sourceNotes[source] ?? '未知来源，不能评估。');
  lines.push('', '### 被拒绝条目（当前有效轨道，逐条）', '');
  for (const m of data.messages)
    for (const u of m.units.filter(
      (u) => u.status === 'rejected' && u.analysis_scope === 'current',
    )) {
      const eff = u.effective as { title: string | null };
      const sg = u.source_guidance as { review_label: string } | null;
      const reason =
        sg?.review_label === 'opening_title_pending'
          ? '结构上是开头导语；根据同来源一致拒绝推测原因，人工没有逐条填写理由。'
          : sg?.review_label === 'related_coverage_pending'
            ? '关联推荐区被拒绝；与用户已确认的 AP 取正文规则一致。'
            : m.source.startsWith('Superhuman')
              ? '赞助栏目被拒绝；不能泛化为所有赞助都拒绝。'
              : '人工未填写明确理由；不得把结构推测当作人工理由。';
      lines.push(
        `- ${m.gmail_message_id} / ${u.unit_id} / ${md(eff.title ?? '[无标题]')}：${reason}`,
      );
    }
  lines.push('', '## C. 全部 uncertain 内容', '');
  let n = 0;
  for (const m of data.messages)
    for (const u of m.units.filter((u) => u.status === 'uncertain')) {
      n++;
      const eff = u.effective as { title: string | null };
      const baseline = u.comparison_baseline as { title: string } | null;
      const review = u.preliminary_review as Record<string, unknown>;
      lines.push(
        `### C.${n} ${md(m.source)} — ${md(eff.title ?? '[无标题]')}`,
        `- 邮件：${md(m.subject)}；接收时间：${m.received_at ?? '未知'}；Gmail Message ID：${m.gmail_message_id}`,
        `- Unit ID：${u.unit_id}；来源：${u.origin}`,
        `- 来源预选基线标题：${md(baseline?.title ?? '未知/无标题')}`,
        `- 人工/最终标题：${md(eff.title ?? '未填写')}；标注内容类型：${u.content_type ?? '未确定'}；结构初判：${review.classification}`,
        `- 原文追溯：${u.source_trace}`,
        '',
        '#### 原文（相关范围完整段落，未截断）',
        '',
        ...(u.original_paragraphs as string[]).map((p) => `> ${md(p).replace(/\n/g, '\n> ')}`),
        '',
        '#### 相邻内容与综合性问题',
        '',
        '```json\n' + JSON.stringify(review, null, 2) + '\n```',
        '',
        '#### 链接、备注与边界证据',
        '',
        '链接仅供静态阅读，已移除查询参数、片段和不透明追踪路径。',
        '```json\n' +
          JSON.stringify(
            {
              links: u.links,
              effective_url: (u.effective as Record<string, unknown>).original_url,
              notes: u.notes,
              boundary: u.boundary,
              boundary_references: u.boundary_references,
              source_range: u.source_range,
              text_evidence: u.text_evidence,
            },
            null,
            2,
          ) +
          '\n```',
        '',
      );
    }
  lines.push(
    `共 ${n} 条 uncertain，全部逐条列出。`,
    '',
    '## D. 关键工程结论',
    '',
    '### 已验证事实',
    '- 原型会把刊头、栏目、广告、导语和正文引用当成候选，也可能把同一正文拆成多个块；人工按来源重建单元。原候选未全面逐条裁决，因此误检/漏检率未知。',
    '- Newsletter 品牌、邮件发送服务和被引文章 Publisher 不等同。URL 可用性与内容类型也不是同一件事。',
    '- 编辑状态、原始候选、人工修正和节点边界必须分离保存。导出保留被废弃轨道，但不将其计作有效 Ground Truth。',
    '### 初步判断',
    '- 优先共享安全 MIME/DOM/链接证据层，加少量来源适配器；不要用一种通用 h 标签规则覆盖所有来源。',
    '- AP、Information AM、Daily Upside 的已确认区域适合规则定位；Reuters/Information Briefing 综合区、Superhuman 新闻/工具合集可能需要人工或后续语义辅助对比实验。',
    '- 不透明 URL 不能靠 LLM 凭空恢复；可用 Plain Text 目标应单列证据，不能伪称已验证重定向。',
    '### 待验证：综合内容是否保留',
    '- 本次仅做结构分类与已暴露 URL 的精确重叠比较。是否仅复述后续分项、是否有独有事实、是否具有独立观点及跨事件分析，目前未逐条完成语义人工标注；报告保持 unknown。',
    '- 建议人工逐项判断：新增事实与原文证据、是否重复其他单元、是否有独立分析、读者能否独立理解；不能因“合集”一概拒绝，也不能因段落较长一概保留。',
    '### 正式 Collector 与 raw_articles 的边界（设计建议，未实施）',
    '- 不把整封 Newsletter 当作一篇文章。区分邮件级记录与内容单元，并保留邮件 ID、来源、原始块位置、解析版本和去重依据。',
    '- standalone_content 可在有足够正文时独立处理；external_reference 只有标题/链接时不能冒充完整原文。没有可验证目标 URL 时不编造，策略需产品决定。',
    '- 内容拆分应保留证据并隔离广告、导航、重复桌面/移动布局；内嵌图片与链接不能自动请求。来源模板漂移需要失败检测。',
    '- 同一文章可能被多封邮件/RSS 推荐；不能只用邮件 ID 去重，也不能把一个源的栏目规则当成全局质量判断。',
    '- 在独立内容边界与负例尚未完整标注之前，不应宣称 Precision/Recall 或直接进入生产。',
    '',
    '## 隐私与导出限制',
    '',
    '- 未读取 OAuth/Token/Cookie 文件，未导出 Gmail 原始 Payload、完整 HTML、收件人列表或发件地址。',
    '- 链接删除所有 query 和 fragment；已知追踪域名/路径完全省略，明显长标识路径片段脱敏。无法安全保留的不透明目标仅保留主机与脱敏标记。',
    '- 正文/备注中的邮箱、已知收件人姓名、明显电话/邮寄地址和敏感赋值串做脱敏；公共新闻人物和作者名称因评审需要保留。',
    '- 自动脱敏不能保证发现所有自由文本身份信息；上传前仍应人工检查。脱敏后的 URL 无法用于订阅跳转/网络验证，这是有意的安全取舍。',
    '- 以上是离线初步技术判断，不包含付费模型或外部网络评估。',
    '',
  );
  return lines.join('\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportAnnotations()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('Annotation export failed:', e instanceof Error ? e.message : 'unknown');
      process.exitCode = 1;
    });
}
