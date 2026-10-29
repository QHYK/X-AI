'use client';

import { useState } from 'react';
import type { AiIgnoredArticle } from '@/lib/dashboard-analytics.js';
import { PutBackButton } from '../../dashboard/analytics/put-back-button.js';
import styles from './ignored.module.css';

export function IgnoredArticlesList(props: { items: AiIgnoredArticle[]; date: string }) {
  const [removed, setRemoved] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const items = props.items.filter((item) => !removed.includes(item.id));
  return (
    <div>
      <p>
        {items.length} article(s) · Daily {props.date}
      </p>
      {message ? <p role="status">{message}</p> : null}
      {!items.length ? (
        <p>No AI ignored articles.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th
                  scope="col"
                  className={styles.sourceColumn}
                >
                  Source
                </th>
                <th scope="col">Title / Content</th>
                <th
                  scope="col"
                  className={styles.actionColumn}
                >
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className={styles.source}>{item.sourceName}</td>
                  <td>
                    <h2 className={styles.title}>
                      {item.title}
                      {item.url && /^https?:\/\//i.test(item.url) ? (
                        <a
                          className={styles.originalLink}
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`打开原文：${item.title}`}
                          title="打开原文"
                        >
                          <span aria-hidden="true">↗</span>
                        </a>
                      ) : null}
                    </h2>
                    <details className={styles.details}>
                      <summary title="展开或收起完整正文">
                        <span className={styles.preview}>
                          {item.contentText
                            ? Array.from(item.contentText.replace(/\s+/g, ' ').trim())
                                .slice(0, 160)
                                .join('')
                            : '没有保存 content_text。'}
                        </span>
                      </summary>
                      <pre className={styles.content}>
                        {item.contentText || '没有保存 content_text。'}
                      </pre>
                    </details>
                  </td>
                  <td className={styles.actions}>
                    <PutBackButton
                      id={item.id}
                      date={props.date}
                      onRestored={() => {
                        setRemoved((current) => [...current, item.id]);
                        setMessage(`已将「${item.title}」恢复到 Daily ${props.date} 的 Digest。`);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
