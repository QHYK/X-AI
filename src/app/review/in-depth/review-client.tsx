'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation.js';
import {
  displayInDepthFields,
  type InDepthReviewItem,
  type InDepthReviewStatus,
} from '@/lib/in-depth-reads.js';
import styles from '../review.module.css';

function apiUrl(): string {
  return window.location.pathname.replace(/\/review\/in-depth\/?$/, '/api/admin/review/in-depth');
}
const STATUSES: InDepthReviewStatus[] = ['pending', 'approved', 'rejected'];

export function InDepthReviewClient(props: {
  initialItems: InDepthReviewItem[];
  status: InDepthReviewStatus;
}) {
  const [items, setItems] = useState(props.initialItems);
  const [selected, setSelected] = useState<InDepthReviewItem | null>(props.initialItems[0] ?? null);
  const [notes, setNotes] = useState(selected?.editorialNotes ?? '');
  const [title, setTitle] = useState(editValue(selected, 'title'));
  const [author, setAuthor] = useState(editValue(selected, 'author'));
  const [summary, setSummary] = useState(editValue(selected, 'summary'));
  const [whyWorthReading, setWhyWorthReading] = useState(editValue(selected, 'whyWorthReading'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function selectItem(id: string) {
    setError(null);
    try {
      const response = await fetch(`${apiUrl()}?id=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      const payload = (await response.json()) as { item?: InDepthReviewItem; error?: string };
      if (!response.ok || !payload.item) throw new Error(payload.error ?? 'Failed to load item.');
      setSelected(payload.item);
      setNotes(payload.item.editorialNotes ?? '');
      setTitle(editValue(payload.item, 'title'));
      setAuthor(editValue(payload.item, 'author'));
      setSummary(editValue(payload.item, 'summary'));
      setWhyWorthReading(editValue(payload.item, 'whyWorthReading'));
      setMessage(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to load item.');
    }
  }

  async function save(reviewStatus: InDepthReviewStatus) {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiUrl(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selected.id,
          reviewStatus,
          editorialNotes: notes,
          editorialOverrides: { title, author, summary, whyWorthReading },
        }),
      });
      const payload = (await response.json()) as { item?: InDepthReviewItem; error?: string };
      if (!response.ok || !payload.item) throw new Error(payload.error ?? 'Failed to save review.');
      setSelected(payload.item);
      setItems((current) =>
        payload.item?.reviewStatus === props.status
          ? current.map((item) => (item.id === payload.item?.id ? payload.item : item))
          : current.filter((item) => item.id !== payload.item?.id),
      );
      setMessage(
        reviewStatus === 'approved' ? 'Approved and visible in In-depth Reads.' : 'Review saved.',
      );
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to save review.');
    } finally {
      setSaving(false);
    }
  }

  const details = selected ? readDetails(selected) : null;
  const display = selected ? displayInDepthFields(selected) : null;

  return (
    <section className={styles.inDepthSection}>
      <nav
        className={styles.inDepthFilters}
        aria-label="In-depth review status"
      >
        {STATUSES.map((value) => (
          <a
            key={value}
            href={`?status=${value}`}
            aria-current={props.status === value ? 'page' : undefined}
          >
            {capitalize(value)}
          </a>
        ))}
      </nav>
      <div className={styles.inDepthGrid}>
        <div
          className={styles.inDepthList}
          aria-label={`${props.status} candidates`}
        >
          {items.length === 0 ? (
            <p className={styles.empty}>No {props.status} candidates.</p>
          ) : null}
          {items.map((item) => {
            const fields = displayInDepthFields(item);
            return (
              <button
                key={item.id}
                type="button"
                className={styles.inDepthListItem}
                aria-pressed={selected?.id === item.id}
                onClick={() => void selectItem(item.id)}
              >
                <strong>{fields.title}</strong>
                <span>
                  {fields.author ?? 'Author unknown'} · {item.publication ?? 'Source unknown'}
                </span>
                <small>{item.url}</small>
                <small>
                  {capitalize(item.discoveryPath)} · {item.contentType ?? 'Unknown type'} ·{' '}
                  {formatDate(item.candidateCreatedAt)}
                </small>
                <small>
                  {capitalize(item.reviewStatus)} · {item.estimatedDurationMinutes ?? '—'} min
                </small>
                <small>Run {item.runId}</small>
              </button>
            );
          })}
        </div>

        <article className={styles.inDepthDetail}>
          {!selected ? (
            <p>Select a candidate to review.</p>
          ) : (
            <>
              <div className={styles.inDepthDetailHeader}>
                <div>
                  <p className={styles.eyebrow}>Discovery · {capitalize(selected.discoveryPath)}</p>
                  <h2>{display?.title}</h2>
                  <p>{selected.originalTitle ?? 'Original title unavailable'}</p>
                </div>
                <span className={styles.inDepthBadge}>{capitalize(selected.reviewStatus)}</span>
              </div>
              <dl className={styles.inDepthMeta}>
                <dt>Author</dt>
                <dd>{selected.author ?? 'Unknown'}</dd>
                <dt>Source</dt>
                <dd>{selected.publication ?? 'Unknown'}</dd>
                <dt>Type / duration</dt>
                <dd>
                  {selected.contentType ?? 'Unknown'} · {selected.estimatedDurationMinutes ?? '—'}{' '}
                  min
                </dd>
                <dt>Discovered</dt>
                <dd>{formatDate(selected.candidateCreatedAt)}</dd>
                <dt>Run ID</dt>
                <dd>
                  <code>{selected.runId}</code>
                </dd>
                <dt>Original URL</dt>
                <dd>
                  {safeHttpUrl(selected.url) ? (
                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open original ↗
                    </a>
                  ) : (
                    selected.url
                  )}
                </dd>
              </dl>

              <section className={styles.inDepthCopy}>
                <h3>Agent summary</h3>
                <p>{selected.summary ?? 'No summary provided.'}</p>
                <h3>Why worth reading</h3>
                <p>{selected.whyWorthReading ?? 'No reason provided.'}</p>
                <h3>Content evidence</h3>
                {details?.evidence.length ? (
                  details.evidence.map((line, index) => <p key={index}>{line}</p>)
                ) : (
                  <p>No evidence provided.</p>
                )}
                <h3>Fetch / source status</h3>
                <p>{details?.fetchStatus ?? 'No fetch status recorded.'}</p>
                <h3>Limitations and risks</h3>
                {details?.limitations.length ? (
                  details.limitations.map((line, index) => <p key={index}>{line}</p>)
                ) : (
                  <p>No limitations recorded.</p>
                )}
                {details?.decision ? <p>Agent evaluation: {details.decision}</p> : null}
              </section>

              <div className={styles.inDepthEditor}>
                <h3>Editorial display</h3>
                <p>Empty fields use the original Candidate value. Agent output stays unchanged.</p>
                <label>
                  Title
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={300}
                  />
                </label>
                <label>
                  Author
                  <input
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                    maxLength={300}
                  />
                </label>
                <label>
                  Summary
                  <textarea
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    maxLength={6000}
                    rows={4}
                  />
                </label>
                <label>
                  Why worth reading
                  <textarea
                    value={whyWorthReading}
                    onChange={(event) => setWhyWorthReading(event.target.value)}
                    maxLength={6000}
                    rows={4}
                  />
                </label>
                <label>
                  Review notes
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    maxLength={6000}
                    rows={3}
                  />
                </label>
                <div className={styles.inDepthActions}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save('approved')}
                  >
                    Approve & publish
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save('rejected')}
                  >
                    Reject / unpublish
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(selected.reviewStatus)}
                  >
                    Save edits & notes
                  </button>
                </div>
                {error ? (
                  <p
                    className={styles.error}
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
                {message ? (
                  <p
                    className={styles.message}
                    role="status"
                  >
                    {message}
                  </p>
                ) : null}
              </div>
              <details className={styles.inDepthRaw}>
                <summary>Raw diagnostic fields</summary>
                <pre>
                  {JSON.stringify(
                    {
                      evidence: selected.evidence,
                      evaluation: selected.evaluation,
                      extraInfo: selected.extraInfo,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function editValue(item: InDepthReviewItem | null, key: string): string {
  const value = item?.editorialOverrides?.[key];
  return typeof value === 'string' ? value : '';
}

function readDetails(item: InDepthReviewItem) {
  const evidence = item.evidence ?? {};
  const evaluation = item.evaluation ?? {};
  const fetch = isRecord(evidence.fetch) ? evidence.fetch : null;
  const evidenceLines = [...strings(evidence.agentEvidence), ...strings(evidence.details)];
  const limitations = [...strings(evidence.limitations), ...strings(evaluation.limitations)];
  const fetchStatus = fetch
    ? `${string(fetch.status) ?? 'Unknown'} · complete: ${booleanLabel(fetch.contentComplete)} · truncated: ${booleanLabel(fetch.truncated)} · returned length: ${numberLabel(fetch.returnedContentLength)}`
    : evidence.contentSource
      ? `${string(evidence.contentSource)} · may be incomplete: ${booleanLabel(evidence.contentMayBeIncomplete)}`
      : null;
  return {
    evidence: evidenceLines,
    limitations,
    fetchStatus,
    decision: string(evaluation.reason) ?? string(evaluation.decision),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}
function booleanLabel(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : 'unknown';
}
function numberLabel(value: unknown): string {
  return typeof value === 'number' ? String(value) : 'unknown';
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function formatDate(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : value;
}
function safeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
