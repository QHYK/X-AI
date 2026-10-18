import { getDatabasePool } from '@/db/index.js';
import { displayInDepthFields, listPublishedInDepthReads } from '@/lib/in-depth-reads.js';
import styles from './reads.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InDepthReadsPage() {
  const works = await listPublishedInDepthReads(getDatabasePool());

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>X-AI-field · Curated reading</p>
        <h1>In-depth Reads</h1>
        <p>值得投入时间的文章、视频与播客，由 Discovery 发现并经人工审核。</p>
      </header>
      <section
        className={styles.grid}
        aria-label="Published In-depth Reads"
      >
        {works.length === 0 ? <p className={styles.empty}>暂无已上架的作品。</p> : null}
        {works.map((work) => {
          const display = displayInDepthFields(work);
          const url = safeHttpUrl(work.url) ? work.url : null;
          return (
            <article
              key={work.id}
              className={styles.card}
            >
              <p className={styles.meta}>
                {work.contentType ?? 'Work'} · {work.estimatedDurationMinutes ?? '—'} min ·{' '}
                {work.publication ?? 'Source unknown'}
              </p>
              <h2>{display.title}</h2>
              <p className={styles.author}>{display.author ?? 'Author unknown'}</p>
              {display.summary ? <p>{display.summary}</p> : null}
              {display.whyWorthReading ? (
                <p className={styles.reason}>{display.whyWorthReading}</p>
              ) : null}
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  阅读原作 ↗
                </a>
              ) : null}
            </article>
          );
        })}
      </section>
    </main>
  );
}

function safeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
