/** Local annotation assistance based on the user's source-specific instructions; NOT a production parser or ground truth. */
import { JSDOM } from 'jsdom';
import { digest, type Preview } from './review-preview.js';
import { linkEvidence } from './link-tools.js';

export const SOURCE_RULE_VERSION = 2;
export type SourceContext = { subject?: string; senderName?: string };
export type LinkEvidence = NonNullable<ReturnType<typeof linkEvidence>> & {
  start_offset: number;
  end_offset: number;
};
export type GuidedUnit = {
  id: string;
  title: string | null;
  content_type: 'standalone_content' | 'external_reference' | 'non_content' | null;
  review_label: string;
  boundary: { start_node_id: string; end_node_id: string };
  source_range: { html_sha256: string; start_offset: number; end_offset: number };
  content_text: string;
  urls: {
    anchor_text: string;
    original_url: string;
    target_url: string | null;
    target_evidence: string;
  }[];
  primary_url: string | null;
  notes: string;
};
export type SourceGuidance = {
  version: number;
  template: string;
  links: LinkEvidence[];
  units: GuidedUnit[];
  warnings: string[];
};
const clean = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
const normalize = (value: string) => value.replace(/[’‘]/g, "'").toLowerCase();
export function extractSourceSections(
  html: string,
  source: string,
  preview: Preview,
  plainText = '',
  context: SourceContext = {},
): SourceGuidance {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const doc = dom.window.document;
  const result: SourceGuidance = {
    version: SOURCE_RULE_VERSION,
    template: source,
    links: [],
    units: [],
    warnings: [],
  };
  try {
    doc
      .querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"]')
      .forEach((e) => e.remove());
    doc.querySelectorAll('[style]').forEach((e) => {
      if (/display:\s*none|mso-hide:\s*all/i.test(e.getAttribute('style') ?? '')) e.remove();
    });
    const text = (e: Element) => clean(e.textContent);
    const start = (e: Element) => dom.nodeLocation(e)?.startOffset ?? -1;
    const end = (e: Element) => dom.nodeLocation(e)?.endOffset ?? -1;
    const find = (selector: string, match: (text: string) => boolean) =>
      Array.from(doc.querySelectorAll(selector)).filter((e) => start(e) >= 0 && match(text(e)));
    const exact = (selector: string, label: string) =>
      find(selector, (t) => normalize(t) === normalize(label));
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const links = anchors.flatMap((e) => {
      const evidence = linkEvidence(e.getAttribute('href') ?? '', text(e), plainText);
      return evidence && start(e) >= 0
        ? [{ ...evidence, start_offset: start(e), end_offset: end(e) }]
        : [];
    });
    result.links = links;
    const textNodes: Text[] = [];
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
    function add(
      a: number,
      b: number,
      title: string | null,
      type: GuidedUnit['content_type'],
      label: string,
      notes = '',
    ) {
      if (a < 0 || b <= a) {
        result.warnings.push(`${label}: 起止标记缺失或顺序不正确`);
        return;
      }
      const blocks = preview.blocks.filter(
        (r) =>
          r.start_offset !== null &&
          r.end_offset !== null &&
          r.start_offset >= a &&
          r.end_offset <= b,
      );
      if (!blocks.length) {
        result.warnings.push(`${label}: 范围没有可定位内容块`);
        return;
      }
      const content = clean(
        textNodes
          .filter((n) => {
            const l = dom.nodeLocation(n);
            return l && l.startOffset >= a && l.endOffset <= b;
          })
          .map((n) => n.textContent)
          .join(' '),
      );
      if (!content) {
        result.warnings.push(`${label}: 内容为空`);
        return;
      }
      const urls = links.filter((e) => e.start_offset < b && e.end_offset > a);
      const headlineLink = title
        ? urls.find((u) => normalize(u.anchor_text) === normalize(title))
        : null;
      const ctaLink = urls.find((u) =>
        /^(?:read (?:more|the full article|our special report)|watch now)$/i.test(u.anchor_text),
      );
      const main = source === 'The Information Briefing' ? urls[0] : (headlineLink ?? ctaLink);
      const raw = digest(`${SOURCE_RULE_VERSION}:${preview.html_sha256}:${a}:${b}:${label}`).slice(
        0,
        32,
      );
      const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-5${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`;
      result.units.push({
        id,
        title,
        content_type: type,
        review_label: label,
        boundary: { start_node_id: blocks[0].node_id, end_node_id: blocks.at(-1)!.node_id },
        source_range: { html_sha256: preview.html_sha256, start_offset: a, end_offset: b },
        content_text: content,
        urls,
        primary_url: main ? (main.target_url ?? main.original_url) : null,
        notes,
      });
    }
    function required(e: Element | undefined, label: string): e is Element {
      if (!e) result.warnings.push(`未找到 ${label}，未猜测替代范围`);
      return !!e;
    }
    function h4Section(heading: Element, stop: number) {
      const heads = Array.from(doc.querySelectorAll('h4')).filter(
        (e) => start(e) > start(heading) && start(e) < stop,
      );
      heads.forEach((e, i) => {
        let stopAt = heads[i + 1] ? start(heads[i + 1]) : stop;
        const sponsor = find('p', (t) => /^A message from\s/i.test(t)).find(
          (p) => start(p) > start(e) && start(p) < stopAt,
        );
        if (sponsor) stopAt = start(sponsor);
        add(start(e), stopAt, text(e), 'external_reference', 'external_reference');
      });
    }
    const firstSentence = (value: string) =>
      [
        ...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean(value)),
      ][0]?.segment.trim() || null;
    const bodyText = (a: number, b: number) =>
      clean(
        textNodes
          .filter((n) => {
            const l = dom.nodeLocation(n);
            return l && l.startOffset >= a && l.endOffset <= b;
          })
          .map((n) => n.textContent)
          .join(' '),
      );
    const ctas = find('td', (t) =>
      /^(?:read more|read the full article|read our special report|watch now)$/i.test(t),
    ).filter((e) => !e.querySelector('td'));
    const footer = find('p', (t) =>
      /^(?:Sponsors are not involved|Want to stop receiving|This email includes limited tracking|Terms & Conditions|©)/i.test(
        t,
      ),
    )[0];
    const footerEnd = footer ? start(footer) : html.length;
    function finish(a: number, b: number) {
      const cta = ctas.filter((e) => start(e) > a && end(e) <= b).at(-1);
      if (cta) return end(cta);
      const blocks = preview.blocks.filter(
        (r) =>
          r.start_offset !== null &&
          r.end_offset !== null &&
          r.start_offset >= a &&
          r.end_offset <= b,
      );
      return blocks.at(-1)?.end_offset ?? b;
    }
    if (source === 'The Information Briefing') {
      const greeting = find('p', (t) => t.startsWith('Greetings!'))[0];
      const titv = find('h3', (t) => normalize(t).startsWith("today on the information's titv"))[0];
      if (required(greeting, 'Greetings!') && required(titv, 'Today on The Information’s TITV')) {
        const heads = Array.from(doc.querySelectorAll('h3')).filter(
          (e) => start(e) >= end(greeting) && start(e) < start(titv),
        );
        add(
          end(greeting),
          heads.length ? start(heads[0]) : start(titv),
          firstSentence(bodyText(end(greeting), heads.length ? start(heads[0]) : start(titv))),
          'standalone_content',
          'opening_sentence',
          '标题取原文第一句话，不生成新事实。',
        );
        heads.forEach((e, i) =>
          add(
            start(e),
            i + 1 < heads.length ? start(heads[i + 1]) : start(titv),
            text(e),
            'standalone_content',
            'standalone_content',
          ),
        );
      }
      const reporters = exact('h2', 'New From Our Reporters')[0];
      if (required(reporters, 'New From Our Reporters')) {
        const stop = Array.from(doc.querySelectorAll('h2')).find(
          (e) => start(e) > start(reporters),
        );
        if (required(stop, '记者推荐之后的 h2')) h4Section(reporters, start(stop));
      }
    } else if (source === 'Reuters Daily Briefing') {
      result.template = context.senderName || source;
      const weekend = /Reuters Weekend Briefing/i.test(context.senderName ?? '');
      const allHeads = Array.from(doc.querySelectorAll('h2')).filter((e) => start(e) >= 0);
      const excluded = allHeads.find(
        (e) => /^And Finally/i.test(text(e)) || (weekend && /^Before I forget/i.test(text(e))),
      );
      const cutoff = Math.min(excluded ? start(excluded) : html.length, footerEnd);
      const heads = allHeads.filter((e) => start(e) < cutoff);
      const author = find('p', (t) => /^By\s/.test(t))[0];
      const before = heads[0] ? start(heads[0]) : cutoff;
      const preamble = find('p', (t) => t.length > 40 && !/^By\s/.test(t)).filter(
        (e) => start(e) > (author ? end(author) : 0) && start(e) < before,
      )[0];
      let first = true;
      const titleFor = (fallback: string) =>
        first && context.subject ? context.subject : fallback;
      const preambleUseful =
        preamble && !/^Hello[.!\s]|^Good (?:morning|afternoon|evening)/i.test(text(preamble));
      let skipQuote = false;
      if (
        !weekend &&
        preambleUseful &&
        (!heads[0] || !/^Today's Top News$/i.test(normalize(text(heads[0]))))
      ) {
        const quote = heads[0] && /^In their own words$/i.test(text(heads[0]));
        const stop = quote ? (heads[1] ? start(heads[1]) : cutoff) : before;
        add(
          start(preamble),
          finish(start(preamble), stop),
          titleFor(text(preamble)),
          'standalone_content',
          'reuters_preamble',
        );
        first = false;
        skipQuote = !!quote;
      }
      heads.forEach((h, i) => {
        if (skipQuote && i === 0) return;
        if (/^The Week in Pictures$/i.test(text(h))) return;
        const stop = i + 1 < heads.length ? start(heads[i + 1]) : cutoff;
        const subs = Array.from(doc.querySelectorAll('h3')).filter(
          (e) => start(e) > start(h) && start(e) < stop,
        );
        const isTop = /^Today's Top News$/i.test(normalize(text(h)));
        let consumed = 0;
        let prefixEnd = subs.length ? start(subs[0]) : stop;
        // A cover photograph under Today's Top News is not a separate article from its h3 story.
        if (isTop && subs.length && !/^In other news$/i.test(text(subs[0]))) {
          const prefix = find(
            'p,li',
            (t) => t.length > 0 && !/REUTERS\/|Source:|Photo:/i.test(t),
          ).filter((e) => start(e) >= end(h) && end(e) <= start(subs[0]));
          if (prefix.reduce((n, e) => n + text(e).length, 0) < 200) {
            prefixEnd = subs[1] ? start(subs[1]) : stop;
            consumed = 1;
          }
        }
        add(
          start(h),
          finish(start(h), prefixEnd),
          titleFor(text(h)),
          'standalone_content',
          'reuters_section',
        );
        first = false;
        subs.slice(consumed).forEach((sub, j, remaining) => {
          const endAt = remaining[j + 1] ? start(remaining[j + 1]) : stop;
          if (/^The Week in Pictures$/i.test(text(sub))) return;
          add(
            start(sub),
            finish(start(sub), endAt),
            text(sub),
            'standalone_content',
            'reuters_subsection',
          );
        });
      });
      if (!result.units.length) result.warnings.push('Reuters: 没有可靠的正文或标题边界');
    } else if (source === 'The Associated Press') {
      const author = find('p', (t) => /^By\s/.test(t))[0];
      const ads = exact('p', 'ADVERTISEMENT');
      const cutoff =
        exact('p', 'IN OTHER NEWS').find((e) => start(e) > (author ? end(author) : -1)) ?? ads[1];
      if (required(author, '首个 By') && required(cutoff, 'IN OTHER NEWS 或第二个 ADVERTISEMENT')) {
        const upper = find('p', (t) => /^[A-Z][A-Z\s&/➤-]+$/.test(t) && /[A-Z]{3}/.test(t)).filter(
          (e) => start(e) >= end(author) && start(e) < start(cutoff),
        );
        upper.forEach((h, i) => {
          const label = text(h),
            stop = i + 1 < upper.length ? start(upper[i + 1]) : start(cutoff);
          if (/^(?:RELATED COVERAGE|ADVERTISEMENT)/.test(label)) {
            return;
          } else {
            const nextParagraph = Array.from(doc.querySelectorAll('p')).find(
              (e) => start(e) >= end(h) && start(e) < stop && text(e),
            );
            add(
              start(h),
              stop,
              nextParagraph ? text(nextParagraph) : label,
              'standalone_content',
              'standalone_content',
              `栏目：${label}。排除 RELATED COVERAGE 和广告；IN OTHER NEWS 及以后不保留。`,
            );
          }
        });
      }
    } else if (source === 'The Information AM') {
      const numbered = find('td', (t) => /^\d+\.$/.test(t));
      const first = numbered.find((e) => text(e) === '1.');
      const popular = exact('h2', 'Popular articles')[0],
        opportunities = exact('h2', 'Opportunities')[0];
      const sponsors = find('p', (t) => /^A message from\s/i.test(t));
      const greeting = find('p', (t) => /^Greetings\s/i.test(t))[0];
      const welcome = find('td,p', (t) => /^Welcome, Weekenders!$/i.test(t)).at(-1);
      const plan = find('h2', (t) => /^(?:Pro|Annual) Subscription$/i.test(t))[0];
      if (plan && !first) {
        result.template = 'information:subscription_ad';
        result.warnings.push('已忽略订阅推广邮件');
      } else if (first) {
        result.template = 'information:am_numbered';
        const stop = Math.min(
          popular ? start(popular) : html.length,
          opportunities ? start(opportunities) : html.length,
        );
        const numbers = numbered.filter((e) => start(e) >= start(first) && start(e) < stop);
        numbers.forEach((e, i) => {
          let b = numbers[i + 1] ? start(numbers[i + 1]) : stop;
          const sponsor = sponsors.find((s) => start(s) > start(e) && start(s) < b);
          if (sponsor) b = start(sponsor);
          const headline = anchors.find((l) => start(l) >= end(e) && start(l) < b && text(l));
          add(
            start(e),
            finish(start(e), b),
            headline ? text(headline) : null,
            'standalone_content',
            'numbered_standalone',
          );
        });
        if (popular) h4Section(popular, opportunities ? start(opportunities) : html.length);
      } else if (greeting && /editor['’]s pick/i.test(context.subject ?? '')) {
        result.template = 'information:editors_pick';
        const firstParagraph = find('p', (t) => !!t).find((e) => start(e) >= end(greeting));
        const follow = exact('p', 'Follow us').find((e) => start(e) >= end(greeting));
        if (required(firstParagraph, 'Greetings 之后的正文') && required(follow, 'Follow us'))
          add(
            start(firstParagraph),
            start(follow),
            context.subject ?? firstSentence(text(firstParagraph)),
            'standalone_content',
            'editors_pick',
          );
      } else if (welcome) {
        result.template = 'information:weekend';
        const stop = Array.from(doc.querySelectorAll('h2')).find((e) => start(e) >= end(welcome));
        if (required(stop, '周末正文后的首个 h2'))
          add(
            start(welcome),
            start(stop),
            context.subject ?? null,
            'standalone_content',
            'weekend_editorial',
          );
      } else {
        result.template = 'information:unknown';
        result.warnings.push('Information: 未识别的邮件模板，未猜测正文');
      }
    } else if (source.startsWith('Superhuman')) {
      const allDaily = Array.from(doc.querySelectorAll('h5'));
      const daily = allDaily.some((e) =>
        /^(?:TODAY IN AI|TUTORIAL|FROM THE FRONTIER|PRODUCTIVITY|PROMPT STATION)$/i.test(text(e)),
      )
        ? allDaily
        : [];
      const alternate = Array.from(doc.querySelectorAll('h4'));
      const science = alternate.some((e) =>
        /^(?:SCIENCE SUNDAY|SUNDAY SCIENCE TRIVIA)$/i.test(text(e)),
      );
      const robotics = alternate.some((e) =>
        /^(?:WHAT['’]S NEXT|ROBOTS IN ACTION|ROBOT OF THE WEEK)$/i.test(text(e)),
      );
      const heads = daily.length ? daily : science || robotics ? alternate : [];
      result.template = daily.length
        ? 'superhuman:daily_h5'
        : science
          ? 'superhuman:science_h4'
          : robotics
            ? 'superhuman:robotics_h4'
            : 'superhuman:unknown';
      const feedback = find('h2', (t) => /^Your opinion matters/i.test(t))[0];
      const terminal = heads.find((e) => daily.length && /^PROMPT STATION$/i.test(text(e)));
      const cutoff = Math.min(
        terminal ? start(terminal) : html.length,
        feedback ? start(feedback) : html.length,
        footerEnd,
      );
      const sections = heads.filter((e) => start(e) < cutoff);
      let first = true;
      sections.forEach((h, i) => {
        const b = sections[i + 1] ? start(sections[i + 1]) : cutoff;
        if (/^(?:PRESENTED\s*BY|SPONSORED\b|SUNDAY SCIENCE TRIVIA$)/i.test(text(h))) return;
        const title = Array.from(doc.querySelectorAll('h2')).find(
          (e) => start(e) >= end(h) && start(e) < b,
        );
        const tools = /^(?:PRODUCTIVITY|NEW TECH)$/i.test(text(h));
        add(
          start(h),
          finish(start(h), b),
          first && context.subject ? context.subject : tools ? text(h) : title ? text(title) : null,
          tools ? 'non_content' : 'standalone_content',
          tools ? 'tools_non_content' : 'superhuman_standalone',
          `栏目：${text(h)}；排除所有赞助栏目，内部 h3 不拆篇。`,
        );
        first = false;
      });
      if (!sections.length) result.warnings.push('Superhuman: 未找到 h5 / h4 栏目');
    } else if (source === 'The Daily Upside') {
      const market = exact('div', 'MARKETS').at(-1),
        cutoff = exact('div', 'Extra Upside').at(-1);
      result.template = market ? 'daily_upside:daily' : 'daily_upside:feature';
      {
        // Feature editions can omit both MARKETS and Extra Upside; explicit bylines still bound each article.
        const bylines = find('p', (t) => /^Written by\s/.test(t)).filter(
          (e) =>
            start(e) > (market ? end(market) : 0) &&
            start(e) < (cutoff ? start(cutoff) : html.length),
        );
        if (!bylines.length)
          result.warnings.push('Daily Upside: 未找到可确认正文边界的 Written by 署名');
        let after = market ? end(market) : 0;
        for (const byline of bylines) {
          const titles = find('div', (t) => t.length > 12 && t.length < 300).filter(
            (e) =>
              start(e) > after &&
              start(e) < start(byline) &&
              !e.querySelector('div,p,h3') &&
              Array.from(e.querySelectorAll('[style]')).some((s) =>
                /font-size:\s*(?:2[0-9]|[3-9][0-9])px/i.test(s.getAttribute('style') ?? ''),
              ),
          );
          const title = titles.at(-1);
          if (title)
            add(
              start(title),
              end(byline),
              text(title),
              'standalone_content',
              'standalone_content',
              '排除 MARKETS 行情和前置推广；以文章标题 div 至 Written by 为边界，不按正文 h3 拆分。',
            );
          else
            result.warnings.push(`未可靠找到 ${text(byline)} 前的文章标题，未合并前置广告或行情`);
          after = end(byline);
        }
      }
    } else if (source === 'Reuters One Essential Read') {
      const heading = doc.querySelector('h2') ?? undefined,
        cutoff = ctas.find((e) => heading && start(e) >= end(heading));
      if (required(heading, 'h2') && required(cutoff, '正文后的阅读链接按钮'))
        add(start(heading), end(cutoff), text(heading), 'standalone_content', 'standalone_content');
    } else result.warnings.push('尚无该来源的用户规则');
    // Retain deterministic ordering; no HTTP, model calls or writes occur here.
    result.units.sort((a, b) => a.source_range.start_offset - b.source_range.start_offset);
    return result;
  } finally {
    dom.window.close();
  }
}

/** Source rules are independent of human annotation files. */
export function createSourceGuidance(
  html: string,
  source: string,
  preview: Preview,
  plainText = '',
  context: SourceContext = {},
) {
  return extractSourceSections(html, source, preview, plainText, context);
}
