'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RuntimeEntry } from '@/lib/dashboard-runtime.js';
import styles from './runtime-files.module.css';
import dashboardStyles from './dashboard.module.css';

async function load(runId: string, path = '', file = false) {
  const params = new URLSearchParams({ runId, path, ...(file ? { file: '1' } : {}) });
  const response = await fetch(`./api/admin/dashboard/runtime-files?${params}`, {
    cache: 'no-store',
  });
  const result = (await response.json()) as {
    message?: string;
    directory?: string;
    entries?: RuntimeEntry[];
    content?: string;
  };
  if (!response.ok) throw new Error(result.message ?? 'Unable to read Runtime files.');
  return result;
}

function Entry({ entry, runId }: { entry: RuntimeEntry; runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [entries, setEntries] = useState<RuntimeEntry[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function toggle() {
    setExpanded(!expanded);
    if (expanded || entries !== null || content !== null || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await load(runId, entry.path, !entry.directory);
      if (entry.directory) setEntries(result.entries ?? []);
      else setContent(result.content ?? '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Read failed.');
    } finally {
      setPending(false);
    }
  }
  return (
    <li className={styles.entry}>
      <button
        type="button"
        className={styles.row}
        onClick={() => void toggle()}
        aria-expanded={expanded}
      >
        <span>
          {entry.directory ? '▸' : '◇'} {entry.name}
        </span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className={styles.contents}>
          {pending && <p role="status">Loading…</p>}
          {error && <p role="alert">{error} Close and reopen to retry.</p>}
          {entries && (
            <Tree
              entries={entries}
              runId={runId}
            />
          )}
          {content !== null && (
            <>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(content);
                    setCopied(true);
                  } catch {
                    setError('Unable to copy. Select and copy the text manually.');
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy content'}
              </button>
              <pre>{content || '(empty file)'}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}
function Tree({ entries, runId }: { entries: RuntimeEntry[]; runId: string }) {
  return entries.length ? (
    <ul className={styles.tree}>
      {entries.map((entry) => (
        <Entry
          key={entry.path}
          entry={entry}
          runId={runId}
        />
      ))}
    </ul>
  ) : (
    <p>Directory is empty.</p>
  );
}

function Drawer({ runId, close }: { runId: string | null; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{ directory?: string; entries?: RuntimeEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    if (runId)
      void load(runId)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch((caught) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : 'Read failed.');
        });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  return createPortal(
    <dialog
      ref={dialog}
      className={styles.drawer}
      aria-labelledby="runtime-files-title"
      onCancel={close}
      onClose={close}
    >
      <header className={styles.header}>
        <h2 id="runtime-files-title">Runtime Files</h2>
        <button
          type="button"
          aria-label="Close Runtime files"
          onClick={close}
        >
          ×
        </button>
      </header>
      {runId && <p className={styles.path}>Run / Attempt: {runId}</p>}
      {data?.directory && <p className={styles.path}>{data.directory}/</p>}
      <p>Preview is read-only. Known credentials are redacted; files are limited to 1 MiB.</p>
      {!runId ? (
        <p>No reliable Runtime mapping for this historical task.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : data ? (
        <Tree
          entries={data.entries ?? []}
          runId={runId}
        />
      ) : (
        <p role="status">Loading…</p>
      )}
    </dialog>,
    document.body,
  );
}

export function RuntimeFiles({ runId, description }: { runId?: string; description: string }) {
  // Freeze the opened attempt even if polling refreshes the parent to a newer run.
  const [opened, setOpened] = useState<{ runId: string | null } | null>(null);
  return (
    <>
      <button
        type="button"
        className={dashboardStyles.metricInfoButton}
        aria-label="View Runtime files"
        title={description}
        onClick={() => setOpened({ runId: runId ?? null })}
      >
        i
      </button>
      {opened && (
        <Drawer
          runId={opened.runId}
          close={() => setOpened(null)}
        />
      )}
    </>
  );
}
