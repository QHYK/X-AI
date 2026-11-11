/** Offline migration regression: all local samples must retain units, dates, IDs, links and text. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { newsletterRawArticles } from '../../src/collectors/gmail/adapter.js';
import { newsletterSource } from '../../src/collectors/gmail/newsletter-source.js';
import type { NewsletterMail } from '../../src/collectors/gmail/newsletter-source.js';
import baseline from './history-baseline.json' with { type: 'json' };
const report = new Map<
  string,
  {
    messages: number;
    units: number;
    standalone: number;
    external: number;
    non_content: number;
    empty: number;
  }
>();
for (const expected of baseline) {
  let data: string | undefined;
  for (const root of ['runtime/spikes/gmail', 'spikes/gmail/runtime/validation']) {
    try {
      data = await readFile(`${root}/parsed/${expected.id}.json`, 'utf8');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  assert.ok(data, `Missing local sample ${expected.id}`);
  const mail = JSON.parse(data) as NewsletterMail;
  assert.equal(newsletterSource(mail), expected.source);
  const articles = newsletterRawArticles(mail);
  assert.equal(articles.length, expected.count, expected.id);
  if (expected.sha256)
    assert.equal(
      createHash('sha256').update(JSON.stringify(articles)).digest('hex'),
      expected.sha256,
      `Migration changed ${expected.id}`,
    );
  else assert.equal(articles.length, 0, 'Explicit subscription advertisement remains excluded');
  const row = report.get(expected.source) ?? {
    messages: 0,
    units: 0,
    standalone: 0,
    external: 0,
    non_content: 0,
    empty: 0,
  };
  row.messages++;
  row.units += articles.length;
  if (!articles.length) row.empty++;
  for (const a of articles) {
    const type = (a.metadata!.newsletter as { content_type: string }).content_type;
    if (type === 'standalone_content') row.standalone++;
    else if (type === 'external_reference') row.external++;
    else row.non_content++;
  }
  report.set(expected.source, row);
}
assert.equal(baseline.length, 62);
console.log(
  JSON.stringify(
    {
      messages: baseline.length,
      units: [...report.values()].reduce((n, r) => n + r.units, 0),
      by_source: Object.fromEntries(report),
      unexpected_empty: 0,
      migration_differences: 0,
    },
    null,
    2,
  ),
);
