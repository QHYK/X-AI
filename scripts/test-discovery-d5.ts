import assert from 'node:assert/strict';
import {
  resolveDiscoveryD5RuntimeConfig,
  validateDiscoveryD5Output,
} from '../src/discovery/open-discovery.js';

const candidate = {
  url: 'https://example.com/work',
  title: 'Original work',
  title_zh: '中文标题',
  author: 'Author',
  publication: 'Publication',
  contentType: 'article',
  publishedAt: null,
  estimatedDurationMinutes: 12,
  summary: '中文摘要',
  whyWorthReading: '中文理由',
  evidence: '正文中的具体论证',
  limitations: '',
  tags: [{ zh: '科学方法', en: 'Scientific Method' }],
  extra_info: '{}',
};

const parsed = validateDiscoveryD5Output({ candidates: [candidate] });
assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.sourceLeadId, undefined, 'Open candidates must not fabricate a Lead.');
assert.throws(
  () => validateDiscoveryD5Output({ candidates: Array.from({ length: 4 }, () => candidate) }),
  /<=3/i,
);
assert.throws(
  () => validateDiscoveryD5Output({ candidates: [{ ...candidate, extra_info: '[]' }] }),
  /JSON object/i,
);

// Assert the live output contract, rather than wording in a frozen Prompt fixture.
assert.deepEqual(validateDiscoveryD5Output({ candidates: [] }), []);
assert.deepEqual(parsed[0]?.extraInfo, {});
assert.deepEqual(parsed[0]?.tags, candidate.tags);
assert.throws(() =>
  validateDiscoveryD5Output({ candidates: [{ ...candidate, sourceLeadId: 'invented-lead' }] }),
);
assert.throws(() =>
  validateDiscoveryD5Output({ candidates: [{ ...candidate, tags: [{ zh: '科学方法', en: '' }] }] }),
);

const config = resolveDiscoveryD5RuntimeConfig({
  ...process.env,
  DISCOVERY_D5_TIMEOUT_MS: '120000',
  DISCOVERY_D5_MAX_TURNS: '5',
  CODEX_MODEL: 'test-model',
});
assert.equal(config.timeoutMs, 120000);
assert.equal(config.maxTurns, 5);
assert.equal(config.model, 'test-model');

console.log('Discovery D5 mock tests passed.');
