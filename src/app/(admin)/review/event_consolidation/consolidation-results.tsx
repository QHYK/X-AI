import type { ConsolidationReview } from '@/lib/event-consolidation-review.js';
import styles from '../review.module.css';

export function ConsolidationResults({ data }: { data: ConsolidationReview }) {
  if (!data.hasRecord)
    return (
      <section className={styles.reviewSection}>
        <p className={styles.empty}>此 Daily Date 没有 Consolidation 记录。</p>
      </section>
    );
  return (
    <section
      className={`${styles.reviewSection} ${styles.consolidationReview}`}
      aria-label="Consolidation results"
    >
      <header className={styles.consolidationSummary}>
        <dl>
          <div>
            <dt>Event Groups</dt>
            <dd>{data.eventGroupCount}</dd>
          </div>
          <div>
            <dt>Routing Corrections</dt>
            <dd>{data.correctionCount}</dd>
          </div>
        </dl>
        <span className={styles.itemMeta}>
          <span>Read-only</span>
        </span>
      </header>
      {data.run ? (
        <p className={styles.snapshot}>
          Latest Stage 3 · {data.run.status} · {data.run.id}
        </p>
      ) : null}
      {data.groups.length === 0 ? (
        <p className={styles.empty}>
          已有 Consolidation 运行记录，尚无已保存的 Routing Correction。
        </p>
      ) : null}
      {data.groups.map((group) => (
        <section
          key={group.id ?? 'unknown'}
          className={styles.consolidationGroup}
          aria-labelledby={`event-group-${group.id ?? 'unknown'}`}
        >
          <header>
            <div>
              <h2 id={`event-group-${group.id ?? 'unknown'}`}>
                {group.hint ?? '原 Event Group 不再可用'}
              </h2>
              <p className={styles.snapshot}>Event Group · {group.id ?? '未记录'}</p>
            </div>
            <span className={styles.itemMeta}>
              <span>
                {group.articles.length} {group.articles.length === 1 ? 'article' : 'articles'}
              </span>
            </span>
          </header>
          <ul aria-label="关联 Digest 文章">
            {group.articles.map((article) => (
              <li key={article.id}>
                <article>
                  <div className={styles.itemMeta}>
                    <span>{article.source}</span>
                    <span>{article.category ?? '原分类未记录'}</span>
                    <span>Article ID：{article.id}</span>
                  </div>
                  <h3>
                    {article.url ? (
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {article.title} ↗
                      </a>
                    ) : (
                      article.title
                    )}
                  </h3>
                </article>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
