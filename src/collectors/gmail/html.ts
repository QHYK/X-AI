import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type NodeReference = {
  node_id: string;
  tag: string;
  node_path: number[];
  start_offset: number | null;
  end_offset: number | null;
  text_sha256: string;
  excerpt: string;
};
export type ContentReferences = { html_sha256: string; blocks: NodeReference[] };
const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
export function prepareContentDocument(html: string) {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const doc = dom.window.document;
  const references = new Map<Element, NodeReference>();
  Array.from(doc.querySelectorAll('*')).forEach((element, index) => {
    const path: number[] = [];
    for (let n: Node | null = element; n?.parentNode; n = n.parentNode)
      path.unshift(Array.from(n.parentNode.childNodes).indexOf(n as ChildNode));
    const location = dom.nodeLocation(element);
    references.set(element, {
      node_id: `n${index}`,
      tag: element.tagName.toLowerCase(),
      node_path: path,
      start_offset: location?.startOffset ?? null,
      end_offset: location?.endOffset ?? null,
      text_sha256: digest(text(element)),
      excerpt: text(element).slice(0, 140),
    });
  });
  const styleSheets = Array.from(doc.styleSheets);
  // Remove invisible and executable content before exposing selectable blocks.
  doc
    .querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"]')
    .forEach((e) => e.remove());
  doc.querySelectorAll('[style]').forEach((e) => {
    if (/display:\s*none|mso-hide:\s*all/i.test(e.getAttribute('style') ?? '')) e.remove();
  });
  const blockElements = Array.from(
    doc.body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,div'),
  ).filter(
    (e) =>
      text(e) &&
      (!e.matches('td,div') || !e.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,div')),
  );
  return { dom, doc, references, blockElements, styleSheets };
}
export function createContentReferences(html: string): ContentReferences {
  const { dom, doc, references, blockElements } = prepareContentDocument(html);
  try {
    doc
      .querySelectorAll(
        'script,style,iframe,frame,frameset,object,embed,svg,math,template,noscript,base,meta,link,form,input,button,textarea,select,option,video,audio,source,track,canvas',
      )
      .forEach((e) => e.remove());
    return {
      html_sha256: digest(html),
      blocks: blockElements.filter((e) => e.isConnected).map((e) => references.get(e)!),
    };
  } finally {
    dom.window.close();
  }
}
