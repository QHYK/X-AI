'use client';

import { useEffect, useRef, useState } from 'react';
import {
  MEMORY_TYPES,
  MemoryCreateSchema,
  MemoryEditSchema,
  type Memory,
  type MemoryCreate,
  type MemoryType,
  type MemoryUpdate,
} from '@/lib/memory-contracts.js';
import styles from './memories.module.css';

type Filter = MemoryType | 'all';
const endpoint = './api/admin/memories';
async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? 'Memory 请求失败，请重试。');
  return body as T;
}
async function readList(type: Filter, signal?: AbortSignal) {
  const query = type === 'all' ? '' : `?type=${encodeURIComponent(type)}`;
  return (
    await json<{ items: Memory[] }>(
      await fetch(`${endpoint}${query}`, {
        cache: 'no-store',
        signal,
      }),
    )
  ).items;
}

export function MemoryManagement() {
  const [type, setType] = useState<Filter>('all');
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void readList(type, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setItems(data);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) {
          setItems([]);
          setError(failure.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [type]);

  async function save(input: MemoryCreate | MemoryUpdate) {
    if (saving.current) throw new Error('已有保存请求，请稍候。');
    saving.current = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const { item } = await json<{ item: Memory }>(
        await fetch(endpoint, {
          method: 'id' in input ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      setItems((current) => current.map((entry) => (entry.id === item.id ? item : entry)));
      setMessage('Memory 已保存。');
      // Re-read database ordering rather than sorting timestamps with lower browser precision.
      try {
        setItems(await readList(type));
      } catch {
        setError('Memory 已保存，但列表刷新失败，请刷新页面查看最新数据。');
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        <label>
          Type
          <select
            aria-label="Memory Type filter"
            value={type}
            disabled={busy}
            onChange={(event) => {
              setType(event.target.value as Filter);
              setLoading(true);
              setError('');
              setMessage('');
              setAdding(false);
            }}
          >
            <option value="all">All</option>
            {MEMORY_TYPES.map((entry) => (
              <option
                key={entry}
                value={entry}
              >
                {entry}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading || busy || adding}
          onClick={() => setAdding(true)}
        >
          Add Memory
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {loading ? (
        <p role="status">Loading…</p>
      ) : (
        <ul
          className={styles.table}
          role="table"
          aria-label="Memories"
        >
          <li
            className={styles.row}
            role="row"
          >
            {['Content', 'Type', 'Priority', 'Enabled', 'Action'].map((heading) => (
              <strong
                key={heading}
                role="columnheader"
              >
                {heading}
              </strong>
            ))}
          </li>
          {adding ? (
            <MemoryRow
              disabled={busy}
              onSave={async (input) => {
                await save(input);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : null}
          {items.map((item) => (
            <MemoryRow
              key={item.id}
              item={item}
              disabled={busy}
              onSave={save}
            />
          ))}
          {!items.length && !adding ? <li className={styles.empty}>No memories.</li> : null}
        </ul>
      )}
    </>
  );
}

function MemoryRow({
  item,
  disabled,
  onSave,
  onCancel,
}: {
  item?: Memory;
  disabled: boolean;
  onSave: (input: MemoryCreate | MemoryUpdate) => Promise<void>;
  onCancel?: () => void;
}) {
  const [editing, setEditing] = useState(!item);
  const [draft, setDraft] = useState({
    content: item?.content ?? '',
    type: item?.type ?? 'general',
    priority: String(item?.priority ?? 0),
    enabled: item?.enabled ?? true,
  });
  const [error, setError] = useState('');
  function reset() {
    setDraft({
      content: item?.content ?? '',
      type: item?.type ?? 'general',
      priority: String(item?.priority ?? 0),
      enabled: item?.enabled ?? true,
    });
    setError('');
  }
  async function submit() {
    const value = { ...draft, priority: draft.priority.trim() ? Number(draft.priority) : NaN };
    const parsed = MemoryEditSchema.safeParse(value);
    if (!parsed.success) {
      setError('请输入非空 Content、有效 Type 和 PostgreSQL 范围内的整数 Priority。');
      return;
    }
    try {
      await onSave(item ? { id: item.id, ...parsed.data } : MemoryCreateSchema.parse(parsed.data));
      setEditing(false);
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <li
      className={styles.row}
      role="row"
      data-memory-id={item?.id ?? 'new'}
    >
      <div role="cell">
        {editing ? (
          <textarea
            aria-label="Content"
            rows={3}
            disabled={disabled}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        ) : (
          <p className={styles.content}>{item?.content}</p>
        )}
      </div>
      <div role="cell">
        {editing ? (
          <select
            aria-label="Type"
            disabled={disabled}
            value={draft.type}
            onChange={(event) => setDraft({ ...draft, type: event.target.value as MemoryType })}
          >
            {MEMORY_TYPES.map((entry) => (
              <option
                key={entry}
                value={entry}
              >
                {entry}
              </option>
            ))}
          </select>
        ) : (
          item?.type
        )}
      </div>
      <div role="cell">
        {editing ? (
          <input
            aria-label="Priority"
            type="number"
            step="1"
            disabled={disabled}
            value={draft.priority}
            onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
          />
        ) : (
          item?.priority
        )}
      </div>
      <div role="cell">
        <input
          aria-label="Enabled"
          type="checkbox"
          checked={editing ? draft.enabled : (item?.enabled ?? true)}
          disabled={disabled || !editing}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
      </div>
      <div
        role="cell"
        className={styles.actions}
      >
        {editing ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void submit()}
            >
              Submit
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                reset();
                if (item) setEditing(false);
                else onCancel?.();
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              reset();
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {error ? (
        <p
          className={styles.rowError}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}
