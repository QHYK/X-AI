import { digest, prepareContentDocument, type ContentReferences } from './html.js';
export { digest, type NodeReference } from './html.js';
export type Preview = ContentReferences & { html: string };
const properties = new Set(
  'color background-color font-family font-size font-weight font-style line-height text-align text-decoration text-transform letter-spacing white-space word-break overflow-wrap width max-width min-width height max-height margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right border border-top border-bottom border-left border-right border-collapse border-spacing border-radius display vertical-align list-style-type table-layout'.split(
    ' ',
  ),
);
function safeDeclarations(style: CSSStyleDeclaration) {
  const declarations: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const key = style.item(i);
    const value = style.getPropertyValue(key);
    if (properties.has(key) && !/url\s*\(|expression|@|[<>\\]|behavior|binding/i.test(value))
      declarations.push(`${key}:${value}`);
  }
  return declarations.join(';');
}
function safeRules(rules: CSSRuleList): string {
  return Array.from(rules)
    .map((rule) => {
      if ('selectorText' in rule && 'style' in rule) {
        const selector = String(rule.selectorText);
        if (/[<>@\\]/.test(selector)) return '';
        return `${selector}{${safeDeclarations(rule.style as CSSStyleDeclaration)}}`;
      }
      if (rule.type === 4 && 'cssRules' in rule && 'conditionText' in rule) {
        const condition = String(rule.conditionText);
        if (/[<>@\\{}]/.test(condition)) return '';
        return `@media ${condition}{${safeRules(rule.cssRules as CSSRuleList)}}`;
      }
      return '';
    })
    .join('\n');
}

/** References point into the original saved HTML, not a selector on a newly rendered document. */
export function createPreview(html: string): Preview {
  const { dom, doc, references, blockElements, styleSheets } = prepareContentDocument(html);
  try {
    const styles = styleSheets.map((sheet) => safeRules(sheet.cssRules)).join('\n');
    const blockSet = new Set(blockElements);
    // Strict HTML/attribute allowlist. No links, forms, scripts, embedded documents or SVG.
    const allowed = new Set(
      'html head body title table thead tbody tfoot tr td th caption colgroup col div span p br hr h1 h2 h3 h4 h5 h6 a b strong i em u s small sub sup ul ol li blockquote pre code center font'.split(
        ' ',
      ),
    );
    const dangerous = new Set(
      'script style iframe frame frameset object embed svg math template noscript base meta link form input button textarea select option video audio source track canvas'.split(
        ' ',
      ),
    );
    for (const element of Array.from(doc.querySelectorAll('*'))) {
      if (!element.isConnected) continue;
      const tag = element.tagName.toLowerCase();
      if (tag === 'img') {
        const placeholder = doc.createElement('span');
        placeholder.textContent = `[图片${element.getAttribute('alt') ? ': ' + element.getAttribute('alt')!.slice(0, 100) : ''}]`;
        placeholder.style.cssText =
          'display:inline-block;background-color:#e9e9e9;color:#666;padding:8px';
        element.replaceWith(placeholder);
        continue;
      }
      if (!allowed.has(tag)) {
        if (dangerous.has(tag)) element.remove();
        else element.replaceWith(...element.childNodes);
        continue;
      }
      const inline = safeDeclarations((element as HTMLElement).style);
      const attrs = Array.from(element.attributes)
        .filter(
          (a) =>
            [
              'class',
              'align',
              'valign',
              'colspan',
              'rowspan',
              'cellpadding',
              'cellspacing',
              'width',
              'height',
              'bgcolor',
              'color',
              'face',
              'size',
              'dir',
              'lang',
            ].includes(a.name) && !/[<>]/.test(a.value),
        )
        .map((a) => [a.name, a.value]);
      Array.from(element.attributes).forEach((a) => element.removeAttribute(a.name));
      for (const [key, value] of attrs) element.setAttribute(key, value);
      if (inline) element.setAttribute('style', inline);
      const reference = references.get(element);
      if (reference && blockSet.has(element))
        element.setAttribute('data-review-node', reference.node_id);
    }
    const csp = doc.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content =
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    doc.head.prepend(csp);
    const style = doc.createElement('style');
    style.textContent = `${styles}\nhtml{scroll-behavior:auto}body{overflow-wrap:anywhere} [data-review-current]{outline:3px solid #d07516!important;outline-offset:2px} [data-review-range]{background-color:#fff0ba!important} [data-review-node]{cursor:crosshair}`;
    doc.head.append(style);
    return {
      html: dom.serialize(),
      html_sha256: digest(html),
      blocks: blockElements
        .filter((e) => e.isConnected && e.hasAttribute('data-review-node'))
        .map((e) => references.get(e)!),
    };
  } finally {
    dom.window.close();
  }
}
