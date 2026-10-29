'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ACTIVE_FRAGMENT_KEYS,
  validatePromptBody,
  type PromptBody,
  type RegistryKey,
} from '@/lib/prompts/contracts.js';
import type {
  PromptRegistryItem,
  PromptManagementDetail,
  ManagedPromptVersion,
} from '@/lib/prompts/registry.js';
import { keyReferenceBody, syncKeyReferences } from '@/lib/prompts/fragment-editor.js';
import styles from './prompts.module.css';

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
/** The only page route is /prompts; resolve both trailing-slash forms without hardcoding basePath. */
function endpoint(key?: RegistryKey) {
  const root = window.location.pathname.endsWith('/')
    ? '../api/admin/prompts'
    : './api/admin/prompts';
  return key ? `${root}/${encodeURIComponent(key)}` : root;
}
async function json<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status === 401
        ? '登录已失效，请重新登录。'
        : (payload.error ?? '请求失败，请检查后重试。'),
      response.status,
    );
  return payload as T;
}
const copy = (body: PromptBody): PromptBody => structuredClone(body);
const time = (value: string) => new Date(value).toLocaleString('zh-CN');
type Action = 'save' | 'createDraft' | 'publish' | 'activate';

export function PromptManagement() {
  const [items, setItems] = useState<PromptRegistryItem[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [showUnreferenced, setShowUnreferenced] = useState(false);
  const [key, setKey] = useState<RegistryKey | null>(null);
  const [detail, setDetail] = useState<PromptManagementDetail | null>(null);
  const [versionId, setVersionId] = useState('');
  const [body, setBody] = useState<PromptBody | null>(null);
  const [systemTarget, setSystemTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutation.current?.abort();
    };
  }, []);
  const version = detail?.versions.find((entry) => entry.id === versionId);
  const dirty = !!body && !!version && JSON.stringify(body) !== JSON.stringify(version.body);
  const editable = version?.status === 'draft';
  const disabled = busy || loading;

  function apply(data: PromptManagementDetail, target?: string) {
    const selected =
      data.versions.find((v) => v.id === target) ??
      data.versions.find((v) => v.id === data.registry.activeVersionId) ??
      data.versions[0];
    setDetail(data);
    setVersionId(selected?.id ?? '');
    setBody(
      selected
        ? selected.status === 'draft'
          ? keyReferenceBody(copy(selected.body), data.fragments)
          : copy(selected.body)
        : null,
    );
    setSystemTarget(selected ? (Object.keys(selected.body.variants)[0] ?? '') : '');
  }
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = await json<{ items: PromptRegistryItem[] }>(
          await fetch(endpoint(), { cache: 'no-store', signal: controller.signal }),
        );
        if (controller.signal.aborted) return;
        setItems(data.items);
        if (data.items.length) setKey(data.items[0].key);
        else setLoading(false);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    }
    void load();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    async function load() {
      try {
        const data = await json<PromptManagementDetail>(
          await fetch(endpoint(key!), { cache: 'no-store', signal: controller.signal }),
        );
        if (!controller.signal.aborted) apply(data);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [key]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function discard() {
    return !dirty || window.confirm('当前有未保存的修改。确认放弃这些修改并重新检查版本吗？');
  }
  function selectKey(next: RegistryKey) {
    if (locked.current || next === key || !discard()) return;
    setError(null);
    setMessage(null);
    setLoading(true);
    setDetail(null);
    setBody(null);
    setKey(next);
  }
  function selectVersion(next: ManagedPromptVersion) {
    if (locked.current || next.id === versionId || !discard()) return;
    setError(null);
    setMessage(null);
    setVersionId(next.id);
    setBody(
      next.status === 'draft' && detail
        ? keyReferenceBody(copy(next.body), detail.fragments)
        : copy(next.body),
    );
    setSystemTarget(Object.keys(next.body.variants)[0] ?? '');
  }
  async function refresh() {
    if (!key || locked.current || !discard()) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const [data, list] = await Promise.all([
        fetch(endpoint(key), { cache: 'no-store', signal: controller.signal }).then(
          json<PromptManagementDetail>,
        ),
        fetch(endpoint(), { cache: 'no-store', signal: controller.signal }).then(
          json<{ items: PromptRegistryItem[] }>,
        ),
      ]);
      if (!controller.signal.aborted) {
        apply(data, versionId);
        setItems(list.items);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function act(action: Action) {
    if (!key || !detail || !version || !body || locked.current || loading) return;
    if (action !== 'save' && dirty) {
      setError('请先保存当前 Draft，或明确放弃修改后再操作。');
      return;
    }
    if (action === 'save' || action === 'publish') {
      try {
        validatePromptBody(key, detail.registry.kind, body);
      } catch (e) {
        setError(`校验失败：${(e as Error).message}`);
        return;
      }
    }
    if (action === 'activate') {
      const from =
        detail.registry.activeVersion === null ? '未设置' : `v${detail.registry.activeVersion}`;
      if (
        !window.confirm(
          `${detail.registry.displayName}\n将从 ${from} 切换到 v${version.version}，确认设置 Active？\n已绑定旧版本的运行任务不会改变。`,
        )
      )
        return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const controller = new AbortController();
    mutation.current = controller;
    let committed = false;
    try {
      const payload =
        action === 'save'
          ? { versionId, expectedHash: version.contentHash, body }
          : action === 'createDraft'
            ? { action, sourceVersionId: versionId, expectedHash: version.contentHash }
            : action === 'publish'
              ? { action, versionId, expectedHash: version.contentHash }
              : { action, versionId, expectedActiveVersionId: detail.registry.activeVersionId };
      const result = await json<{ version: { id: string } }>(
        await fetch(endpoint(key), {
          method: action === 'save' ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
      );
      committed = true;
      const [latest, list] = await Promise.all([
        fetch(endpoint(key), { cache: 'no-store', signal: controller.signal }).then(
          json<PromptManagementDetail>,
        ),
        fetch(endpoint(), { cache: 'no-store', signal: controller.signal }).then(
          json<{ items: PromptRegistryItem[] }>,
        ),
      ]);
      if (controller.signal.aborted) return;
      apply(latest, result.version.id);
      setItems(list.items);
      setMessage(
        action === 'save'
          ? 'Draft 已保存。'
          : action === 'createDraft'
            ? '已创建新的 Draft。'
            : action === 'publish'
              ? '版本已发布；当前 Active 未改变。'
              : 'Active Version 已切换；已绑定运行继续使用原版本。',
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      const failure = e as Error;
      setError(
        committed
          ? '操作已成功，但详情刷新失败。当前内容已保留，请手动刷新核实。'
          : e instanceof ApiError && e.status === 409
            ? `发生冲突：${failure.message} 当前页面的未保存内容未被覆盖，请重新检查版本。`
            : failure.message,
      );
      // Never refresh or replace local editor state on failure, particularly HTTP 409.
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function editBody(next: PromptBody) {
    setBody(syncKeyReferences(next));
  }
  function insertFragment(fragmentKey: RegistryKey) {
    if (!body || !detail) return;
    const next = keyReferenceBody(body, detail.fragments);
    const roles = systemTarget ? next.variants[systemTarget] : next;
    if (!roles) return;
    const token = `{{fragment.${fragmentKey}}}`;
    if ((roles.systemInstructions ?? '').includes(token)) return;
    const text = roles.systemInstructions ? `${roles.systemInstructions}\n\n${token}` : token;
    editBody(
      systemTarget
        ? {
            ...next,
            variants: { ...next.variants, [systemTarget]: { ...roles, systemInstructions: text } },
          }
        : { ...next, systemInstructions: text },
    );
  }
  function roles(
    name: string,
    value: { systemInstructions: string | null; userTemplate: string | null },
    update: (role: 'systemInstructions' | 'userTemplate', text: string) => void,
  ) {
    return (
      <fieldset
        key={name}
        className={styles.roles}
        disabled={!editable || disabled}
      >
        <legend>{name}</legend>
        <label>
          System Instructions
          <textarea
            aria-label={`${name} System Instructions`}
            value={value.systemInstructions ?? ''}
            rows={14}
            onFocus={() => setSystemTarget(name === '基础' ? '' : name)}
            onChange={(e) => update('systemInstructions', e.target.value)}
          />
        </label>
        <label>
          User Prompt Template
          <textarea
            aria-label={`${name} User Prompt Template`}
            value={value.userTemplate ?? ''}
            rows={8}
            onChange={(e) => update('userTemplate', e.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  const filtered = items.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      (item.kind !== 'fragment' || showUnreferenced || item.usedByRequests.length > 0) &&
      item.key.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
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
          className={styles.success}
          role="status"
        >
          {message}
        </p>
      ) : null}
      <div className={styles.layout}>
        <aside
          className={styles.card}
          aria-label="Prompt 列表"
        >
          <label>
            搜索 Key
            <input
              aria-label="搜索 Prompt Key"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            类型
            <select
              aria-label="Prompt 类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">全部类型</option>
              <option value="request">Request</option>
              <option value="fragment">Fragment</option>
            </select>
          </label>
          <label className={styles.filterToggle}>
            <input
              type="checkbox"
              aria-label="Show unreferenced"
              checked={showUnreferenced}
              onChange={(e) => setShowUnreferenced(e.target.checked)}
            />
            Show unreferenced
          </label>
          <p className={styles.muted}>
            {filtered.length} / {items.length} Registry
          </p>
          <ul className={styles.registryList}>
            {filtered.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={item.key === key}
                  onClick={() => selectKey(item.key)}
                >
                  <span className={styles.muted}>
                    {item.workflow} → {item.step} ·{' '}
                    {item.kind === 'request' ? 'Request' : 'Fragment'}
                  </span>
                  <strong>{item.displayName}</strong>
                  <code>{item.key}</code>
                  <span className={styles.version}>
                    {item.activeVersion === null ? '未设置' : `v${item.activeVersion}`}
                  </span>
                  {/* <small className={styles.muted}>更新于 {time(item.updatedAt)}</small> */}
                </button>
              </li>
            ))}
          </ul>
          {!loading && !items.length ? (
            <p>尚无 Registry。请先完成已审核的基线导入；本页面不会自动导入数据。</p>
          ) : null}
          {!!items.length && !filtered.length ? <p>没有匹配的 Prompt。</p> : null}
        </aside>
        <section
          className={styles.detail}
          aria-label="Prompt 详情"
          aria-busy={disabled}
        >
          {loading ? <p role="status">正在加载 Prompt…</p> : null}
          {!detail && !loading ? (
            <p>请选择一个 Prompt。{error ? '可重新选择或刷新页面重试。' : ''}</p>
          ) : null}
          {detail ? (
            <>
              <header className={styles.card}>
                <div className={styles.toolbar}>
                  <h2>{detail.registry.displayName}</h2>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={disabled}
                  >
                    刷新详情
                  </button>
                </div>
                <code>{detail.registry.key}</code>
                <p>
                  Active 版本：
                  <strong>
                    {detail.registry.activeVersion === null
                      ? '未设置'
                      : `v${detail.registry.activeVersion}`}
                  </strong>{' '}
                  · {detail.registry.kind === 'request' ? 'Request' : 'Shared Fragment'}
                </p>
                {detail.registry.kind === 'fragment' ? (
                  <p className={styles.notice}>
                    {(ACTIVE_FRAGMENT_KEYS as readonly string[]).includes(detail.registry.key)
                      ? '动态 Active Fragment：新 Run 固定开始时的 Active；已有 Run 的 Retry / Resume 使用原快照。'
                      : '普通 Fragment：Request 绑定精确 Published Version；发布或激活新 Fragment 不会自动升级已有引用。'}
                  </p>
                ) : null}
                {detail.registry.kind === 'fragment' ? (
                  <section aria-label="Used by Requests">
                    <h3>Used by Requests</h3>
                    {detail.registry.usedByRequests.length ? (
                      <ul className={styles.usedBy}>
                        {detail.registry.usedByRequests.map((requestKey) => (
                          <li key={requestKey}>
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => selectKey(requestKey)}
                            >
                              <code>{requestKey}</code>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.muted}>No current Request references</p>
                    )}
                  </section>
                ) : null}
              </header>
              <section
                className={styles.card}
                aria-label="完整版本历史"
              >
                <h3>版本历史</h3>
                <div className={styles.history}>
                  {detail.versions.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      disabled={disabled}
                      aria-pressed={item.id === versionId}
                      onClick={() => selectVersion(item)}
                    >
                      v{item.version} · {item.status === 'draft' ? 'Draft' : 'Published'}
                      {item.id === detail.registry.activeVersionId ? ' · Active' : ''}
                      <small>{time(item.createdAt)}</small>
                    </button>
                  ))}
                </div>
                {!detail.versions.length ? <p>此 Registry 尚无版本。</p> : null}
              </section>
              {version && body ? (
                <section
                  className={styles.card}
                  aria-label="Prompt 内容"
                >
                  <div className={styles.toolbar}>
                    <h3>
                      v{version.version} · {editable ? 'Draft，可编辑' : 'Published，只读'}
                    </h3>
                    {dirty ? <span className={styles.badge}>有未保存修改</span> : null}
                  </div>
                  <p className={styles.muted}>
                    创建于 {time(version.createdAt)}
                    {version.changeNote ? ` · ${version.changeNote}` : ''}
                  </p>
                  <p className={styles.muted}>
                    UUID：{version.id}
                    <br />
                    来源 Commit：{version.sourceCommit ?? '—'}
                  </p>
                  {detail.registry.kind === 'fragment' ? (
                    <fieldset
                      className={styles.roles}
                      disabled={!editable || disabled}
                    >
                      <legend>Shared Fragment</legend>
                      <label>
                        Fragment 内容
                        <textarea
                          aria-label="Fragment 内容"
                          rows={20}
                          value={body.systemInstructions ?? ''}
                          onChange={(e) => setBody({ ...body, systemInstructions: e.target.value })}
                        />
                      </label>
                    </fieldset>
                  ) : (
                    <>
                      <p className={styles.notice}>
                        System / User 可为空；动态输入仍由代码提供。模板仅支持 {'{{input}}'}
                        、适用请求的 {'{{category}}'} 及 System 中的 {'{{fragment.<key>}}'}。
                      </p>
                      {!Object.keys(body.variants).length
                        ? roles('基础', body, (role, text) => editBody({ ...body, [role]: text }))
                        : null}
                      {Object.entries(body.variants).map(([name, value]) =>
                        roles(name, value, (role, text) =>
                          editBody({
                            ...body,
                            variants: { ...body.variants, [name]: { ...value, [role]: text } },
                          }),
                        ),
                      )}
                      <fieldset
                        className={styles.roles}
                        disabled={!editable || disabled}
                      >
                        <legend>Fragment 引用</legend>
                        <p className={styles.muted}>
                          占位符在 System 模板中的位置决定内容顺序。三个 System Fragment 使用动态
                          Active， 新 Run 固定版本；普通 Fragment 必须明确选择 Published
                          Version，不自动升级。 手动输入 Key 可识别引用；删除时检查所有条件变体。
                        </p>
                        {Object.keys(body.variants).length ? (
                          <label>
                            插入到 System 变体
                            <select
                              aria-label="Fragment target"
                              value={systemTarget}
                              onChange={(e) => setSystemTarget(e.target.value)}
                            >
                              {Object.keys(body.variants).map((name) => (
                                <option
                                  key={name}
                                  value={name}
                                >
                                  {name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <label>
                          添加 Fragment
                          <select
                            aria-label="添加 Fragment"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) insertFragment(e.target.value as RegistryKey);
                            }}
                          >
                            <option value="">选择 Fragment</option>
                            {items
                              .filter((item) => item.kind === 'fragment')
                              .map((item) => (
                                <option
                                  key={item.key}
                                  value={item.key}
                                >
                                  {item.key}
                                </option>
                              ))}
                          </select>
                        </label>
                        {body.fragments.map((ref, index) => {
                          const selected = detail.fragments.find((f) => f.id === ref.versionId);
                          const fragmentKey = ref.key ?? ref.activeKey ?? selected?.key;
                          const registry = items.find((item) => item.key === fragmentKey);
                          return (
                            <div
                              className={styles.fragment}
                              key={fragmentKey ?? index}
                            >
                              <strong>{fragmentKey ?? '无法解析历史 Fragment'}</strong>
                              {ref.activeKey ? (
                                <p>
                                  动态 Active ·{' '}
                                  {registry?.activeVersion != null
                                    ? `v${registry.activeVersion}`
                                    : '未设置'}
                                  （已有 Run 使用快照）
                                </p>
                              ) : (
                                <label>
                                  Published Version
                                  <select
                                    aria-label={`Fragment version ${index + 1}`}
                                    value={ref.versionId ?? ''}
                                    onChange={(e) =>
                                      setBody({
                                        ...body,
                                        fragments: body.fragments.map((r, i) =>
                                          i === index
                                            ? { ...r, versionId: e.target.value || undefined }
                                            : r,
                                        ),
                                      })
                                    }
                                  >
                                    <option value="">请选择精确版本</option>
                                    {detail.fragments
                                      .filter((f) => f.key === fragmentKey)
                                      .map((f) => (
                                        <option
                                          key={f.id}
                                          value={f.id}
                                        >
                                          {f.key} · v{f.version}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                              )}
                              <pre className={styles.fragmentText}>
                                {ref.activeKey
                                  ? (detail.fragments.find(
                                      (f) => f.id === registry?.activeVersionId,
                                    )?.body.systemInstructions ?? '当前 Active 内容不可用')
                                  : (selected?.body.systemInstructions ??
                                    '请选择 Published Version')}
                              </pre>
                            </div>
                          );
                        })}
                      </fieldset>
                    </>
                  )}
                  <p className={styles.notice}>
                    <strong>Publish 只发布版本，不会改变当前生产使用的 Active。</strong>设置 Active
                    或回滚需要另行确认；已绑定版本的任务继续使用原版本。
                  </p>
                  <div className={styles.toolbar}>
                    <button
                      type="button"
                      disabled={disabled || dirty}
                      onClick={() => void act('createDraft')}
                    >
                      从此版本创建 Draft
                    </button>
                    {editable ? (
                      <>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => void act('save')}
                        >
                          保存 Draft
                        </button>
                        <button
                          type="button"
                          disabled={disabled || dirty}
                          onClick={() => void act('publish')}
                        >
                          Publish
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled || version.id === detail.registry.activeVersionId}
                        onClick={() => void act('activate')}
                      >
                        {detail.registry.activeVersion !== null &&
                        version.version < detail.registry.activeVersion
                          ? '回滚并设为 Active'
                          : '设为 Active'}
                      </button>
                    )}
                    {busy ? <span role="status">操作中…</span> : null}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}
