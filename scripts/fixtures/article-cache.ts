import { attachPromptMemory, PromptMemory } from './prompt-runtime.js';
import assert from 'node:assert/strict';
import type { ArticleDatabase, ArticleDocument } from '../../src/lib/article-fetch-cache.js';

export const articleUrl = 'https://example.test/selected';
export const articleText =
  '# Article\n\n' + '已保存的文章正文，包含核心问题、论证、关键事实和结论。'.repeat(30);
export function article(overrides: Partial<ArticleDocument> = {}): ArticleDocument {
  return {
    url: articleUrl,
    finalUrl: articleUrl,
    fetchedAt: '2026-10-19T10:00:00Z',
    status: 'success',
    markdown: articleText,
    isComplete: true,
    metadata: { title: 'Original', publication: 'Publisher' },
    coverImage: null,
    error: null,
    origin: 'fetch',
    ...overrides,
  };
}
type CacheRow = {
  normalized_url: string;
  normalized_final_url: string;
  original_url: string;
  final_url: string;
  fetched_at: string;
  markdown: string;
  is_complete: boolean;
  metadata: Record<string, unknown>;
};

/** Transaction/lock simulation: separate connections see only committed cache rows. */
export class ArticleStore {
  cache = new Map<string, CacheRow>();
  daily: Record<string, unknown>[] = [];
  source: Record<string, unknown> | null = {
    candidate_id: '00000000-0000-4000-8000-000000000001',
    title: 'Original',
    author: 'Author',
    url: articleUrl,
    source_content_id: null,
    summary: 'Original Agent summary',
    extra_info: { diagnostic: 'Original Agent metadata stays unchanged' },
    why_worth_reading: 'Original Agent reason',
    publication: 'Publisher',
    evidence: { details: ['Internal evidence'] },
  };
  editorial: Record<string, unknown> | null = null;
  failWrite = false;
  failEditorial = false;
  failLookup = false;
  writes: string[] = [];
  released = 0;
  private locks = new Map<string, Promise<void>>();

  seed(document = article()) {
    this.cache.set(document.url, {
      normalized_url: document.url,
      normalized_final_url: document.finalUrl,
      original_url: document.url,
      final_url: document.finalUrl,
      fetched_at: document.fetchedAt,
      markdown: document.markdown,
      is_complete: document.isComplete,
      metadata: document.metadata,
    });
  }
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql.includes('from discovery_fetch_cache')) {
      if (this.failLookup) throw new Error('Mock missing cache table');
      const key = values[0];
      return {
        rows: [...this.cache.values()].filter(
          (row) =>
            (row.normalized_url === key || row.normalized_final_url === key) && row.is_complete,
        ),
      };
    }
    if (sql.includes('from raw_articles ra')) {
      const urls = values[0] as string[];
      const rows = this.daily.flatMap((row) => {
        const completion = (row.metadata as { content_completion?: Record<string, unknown> } | null)
          ?.content_completion;
        const full =
          row.full_content_text ||
          (completion?.status === 'success' &&
          completion.content_type === 'article_body' &&
          completion.full_content_length === 0
            ? row.content_text
            : null);
        return full &&
          (urls.includes(String(row.url)) || (values[1] && row.source_content_id === values[1]))
          ? [{ ...row, full_content_text: full }]
          : [];
      });
      return { rows };
    }
    if (sql.includes('select dc.title') || sql.includes('select dc.id as candidate_id'))
      return {
        rows: this.source
          ? [
              {
                ...this.source,
                editorial_summary: this.editorial?.summary ?? null,
                editorial_why_worth_reading: this.editorial?.whyWorthReading ?? null,
                editorial_extra_info: this.editorial?.extra_info ?? null,
              },
            ]
          : [],
      };
    if (sql.includes('select editorial_summary as summary'))
      return { rows: this.source ? [{ ...this.editorial }] : [] };
    if (sql.includes('update in_depth_candidates')) {
      assert.ok(sql.includes('set editorial_summary = $2'));
      assert.ok(sql.includes('editorial_why_worth_reading = $3'));
      assert.ok(sql.includes('editorial_extra_info = $4'));
      assert.ok(!sql.includes('editorial_overrides'));
      assert.ok(
        !sql.includes('review_status') &&
          !sql.includes('editorial_notes') &&
          !sql.includes('reviewed_at'),
      );
      if (this.failEditorial) throw new Error('Mock Editorial save failure');
      assert.ok(sql.includes("coalesce(editorial_summary, '') = $5"));
      if (
        [
          this.editorial?.summary ?? '',
          this.editorial?.whyWorthReading ?? '',
          this.editorial?.extra_info ?? '',
        ].some((v, i) => v !== values[i + 4])
      )
        return { rows: [] };
      this.editorial = {
        summary: values[1],
        whyWorthReading: values[2],
        extra_info: values[3],
      };
      this.writes.push('editorial');
      return { rows: [{ id: values[0] }] };
    }
    throw new Error(`Unexpected Mock query: ${sql}`);
  }
  async connect() {
    let unlock: (() => void) | undefined;
    let pending: CacheRow | undefined;
    const releaseLock = () => {
      unlock?.();
      unlock = undefined;
    };
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === 'begin' || sql.startsWith('set local')) return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          const key = String(values[0]);
          const previous = this.locks.get(key) ?? Promise.resolve();
          let finish!: () => void;
          const current = new Promise<void>((resolve) => {
            finish = resolve;
          });
          this.locks.set(key, current);
          await previous;
          unlock = () => {
            finish();
            if (this.locks.get(key) === current) this.locks.delete(key);
          };
          return { rows: [] };
        }
        if (sql === 'commit') {
          if (pending) {
            this.cache.set(pending.normalized_url, pending);
            this.writes.push('cache');
          }
          releaseLock();
          return { rows: [] };
        }
        if (sql === 'rollback') {
          pending = undefined;
          releaseLock();
          return { rows: [] };
        }
        if (sql.includes('insert into discovery_fetch_cache')) {
          if (this.failWrite) throw new Error('Mock Cache write failure');
          const old = this.cache.get(String(values[0]));
          if (!old?.is_complete || values[6])
            pending = {
              normalized_url: String(values[0]),
              normalized_final_url: String(values[1]),
              original_url: String(values[2]),
              final_url: String(values[3]),
              fetched_at: String(values[4]),
              markdown: String(values[5]),
              is_complete: Boolean(values[6]),
              metadata: JSON.parse(String(values[7])),
            };
          return { rows: [] };
        }
        return this.query(sql, values);
      },
      release: () => {
        releaseLock();
        this.released++;
      },
    };
  }
  private prompts = new PromptMemory();
  get db(): ArticleDatabase {
    return attachPromptMemory(this as unknown as ArticleDatabase, this.prompts);
  }
}
