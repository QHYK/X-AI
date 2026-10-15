'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DashboardDay } from '@/lib/dashboard.js';
import type {
  IgnoredArticle,
  SourceAnalyticsDay,
  SourceAnalyticsRow,
} from '@/lib/dashboard-analytics.js';
import { sortSourceRows } from '@/lib/source-analytics-sort.js';
import styles from '../dashboard.module.css';

type Range = '7' | '30' | 'custom';
type SortDirection = 'ascending' | 'descending';
type RangeState = { range: Range; startDate: string; endDate: string };

const initialRange: RangeState = { range: '7', startDate: '', endDate: '' };

export function ContentAnalytics() {
  return (
    <>
      <DailyVolumeModule />
      <SourceAnalyticsModule />
    </>
  );
}

function DailyVolumeModule() {
  const [range, setRange] = useState<RangeState>(initialRange);
  const [days, setDays] = useState<DashboardDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadJson<{ days: DashboardDay[] }>(
      `../api/dashboard/analytics/daily-volume?${query(range)}`,
    )
      .then((value) => {
        setDays(value.days);
        setError(null);
      })
      .catch((value: Error) => setError(value.message))
      .finally(() => setLoading(false));
  }, [range]);
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.kicker}>Daily volume</p>
          <h2>Historical Daily Volume</h2>
        </div>
        <RangeControls
          value={range}
          onChange={setRange}
        />
      </div>
      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : error ? (
        <p className={styles.empty}>{error}</p>
      ) : (
        <DailyVolumeTable days={days} />
      )}
    </section>
  );
}

function DailyVolumeTable({ days }: { days: DashboardDay[] }) {
  const headings = [
    'Date',
    'Raw',
    'Pending',
    'Selected',
    'Ignored',
    'Failed',
    'Completion',
    'Backlog',
    'Completion Duration',
    'Stage 1 Duration',
    'Processed',
    'Event',
    'Digest',
    'Long-form',
    'Inspiration',
    'Stage2 Groups',
    'Stage3 Events',
    'Published',
    'Draft',
    'LLM Calls',
    'Input Tokens',
    'Output Tokens',
    'Duration',
  ];
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th>{day.date}</th>
              <td>{day.raw.total}</td>
              <td>{day.raw.pending}</td>
              <td>{day.raw.selected}</td>
              <td>{day.raw.ignored}</td>
              <td>{day.raw.failed}</td>
              <td>
                {ratio(
                  day.runtime.contentCompletion?.successCount,
                  day.runtime.contentCompletion?.selectedCount,
                )}
              </td>
              <td>{day.completionBacklog}</td>
              <td>{duration(day.runtime.contentCompletion?.durationMs)}</td>
              <td>{duration(day.runtime.stages.stage1?.durationMs)}</td>
              <td>{day.processed.total}</td>
              <td>{day.processed.event}</td>
              <td>{day.processed.digest}</td>
              <td>{day.processed.long_form}</td>
              <td>{day.processed.inspiration}</td>
              <td>{metric(day.runtime.stages.stage2?.groupCount)}</td>
              <td>{metric(day.runtime.stages.stage3?.selectedEventCount)}</td>
              <td>{day.events.published}</td>
              <td>{day.events.draft}</td>
              <td>{metric(day.runtime.llmCalls)}</td>
              <td>{metric(day.runtime.inputTokens)}</td>
              <td>{metric(day.runtime.outputTokens)}</td>
              <td>{duration(day.runtime.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceAnalyticsModule() {
  const [range, setRange] = useState<RangeState>(initialRange);
  const [rows, setRows] = useState<SourceAnalyticsRow[]>([]);
  const [selected, setSelected] = useState<SourceAnalyticsRow | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('descending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadJson<{ rows: SourceAnalyticsRow[] }>(
      `../api/dashboard/analytics/sources?${query(range)}`,
    )
      .then((value) => {
        setRows(value.rows);
        setError(null);
      })
      .catch((value: Error) => setError(value.message))
      .finally(() => setLoading(false));
  }, [range]);
  const sortedRows = useMemo(() => sortSourceRows(rows, sortDirection), [rows, sortDirection]);
  return (
    <section className={styles.analyticsLayout}>
      <div className={styles.panel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.kicker}>Source channel</p>
            <h2>Source Channel Analytics</h2>
          </div>
          <RangeControls
            value={range}
            onChange={(nextRange) => {
              setSelected(null);
              setRange(nextRange);
            }}
          />
        </div>
        {loading ? (
          <p className={styles.empty}>Loading…</p>
        ) : error ? (
          <p className={styles.empty}>{error}</p>
        ) : (
          <SourceTable
            rows={sortedRows}
            sortDirection={sortDirection}
            onToggleSort={() =>
              setSortDirection((current) => (current === 'descending' ? 'ascending' : 'descending'))
            }
            onSelect={setSelected}
          />
        )}
      </div>
      {selected ? (
        <SourceDetail
          key={`${selected.sourceId}-${query(range)}`}
          source={selected}
          range={range}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function SourceTable({
  rows,
  sortDirection,
  onToggleSort,
  onSelect,
}: {
  rows: SourceAnalyticsRow[];
  sortDirection: SortDirection;
  onToggleSort: () => void;
  onSelect: (row: SourceAnalyticsRow) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Source Channel</th>
            <th>Raw</th>
            <th>Selected</th>
            <th>Ignored</th>
            <th>Duplicate</th>
            <th>Pending</th>
            <th>Failed</th>
            <th aria-sort={sortDirection}>
              <button
                className={styles.sortButton}
                type="button"
                onClick={onToggleSort}
              >
                Selection Rate {sortDirection === 'descending' ? '↓' : '↑'}
              </button>
            </th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceId}>
              <th>{row.sourceName}</th>
              <td>{row.raw}</td>
              <td>{row.selected}</td>
              <td>{row.ignored}</td>
              <td>{row.duplicate}</td>
              <td>{row.pending}</td>
              <td>{row.failed}</td>
              <td>{selectionRate(row)}</td>
              <td>
                <button
                  className={styles.retryButton}
                  type="button"
                  onClick={() => onSelect(row)}
                >
                  Details
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceDetail({
  source,
  range,
  onClose,
}: {
  source: SourceAnalyticsRow;
  range: RangeState;
  onClose: () => void;
}) {
  const [days, setDays] = useState<SourceAnalyticsDay[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [articles, setArticles] = useState<IgnoredArticle[]>([]);
  const [articleTotal, setArticleTotal] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => {
    void loadJson<{ rows: SourceAnalyticsDay[] }>(
      `../api/dashboard/analytics/source-days?sourceId=${source.sourceId}&${query(range)}`,
    ).then((value) => setDays(value.rows));
  }, [source.sourceId, range]);
  useEffect(() => {
    if (!date) return;
    void loadJson<{ items: IgnoredArticle[]; total: number }>(
      `../api/dashboard/analytics/ignored-articles?sourceId=${source.sourceId}&date=${date}&page=${page}`,
    ).then((value) => {
      setArticles((current) => (page === 1 ? value.items : [...current, ...value.items]));
      setArticleTotal(value.total);
    });
  }, [source.sourceId, date, page]);
  return (
    <aside className={styles.analyticsDetail}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.kicker}>Source details</p>
          <h2>{source.sourceName}</h2>
        </div>
        <button
          className={styles.retryButton}
          type="button"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Raw</th>
              <th>Selected</th>
              <th>Ignored</th>
              <th>Duplicate</th>
              <th>Rate</th>
              <th>View</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th>{day.date}</th>
                <td>{day.raw}</td>
                <td>{day.selected}</td>
                <td>{day.ignored}</td>
                <td>{day.duplicate}</td>
                <td>{selectionRate(day)}</td>
                <td>
                  <button
                    className={styles.retryButton}
                    type="button"
                    onClick={() => {
                      setDate(day.date);
                      setArticles([]);
                      setArticleTotal(0);
                      setPage(1);
                    }}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {date ? (
        <div className={styles.analyticsIgnored}>
          <h3>Ignored articles · {date}</h3>
          {articles.length === 0 ? (
            <p className={styles.empty}>No ignored articles.</p>
          ) : (
            <ul>
              {articles.map((item) => (
                <li key={item.id}>
                  <strong>{item.ignoreType}</strong>
                  <span>
                    {item.title}
                    <small>{item.sourceName}</small>
                  </span>
                  {item.url ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {articles.length < articleTotal ? (
            <button
              className={styles.retryButton}
              type="button"
              onClick={() => setPage((current) => current + 1)}
            >
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function RangeControls({
  value,
  onChange,
}: {
  value: RangeState;
  onChange: (next: RangeState) => void;
}) {
  return (
    <div className={styles.analyticsControls}>
      <select
        value={value.range}
        onChange={(event) => onChange({ ...value, range: event.target.value as Range })}
      >
        <option value="7">最近 7 日</option>
        <option value="30">最近 30 日</option>
        <option value="custom">自定义</option>
      </select>
      {value.range === 'custom' ? (
        <>
          <input
            type="date"
            value={value.startDate}
            onChange={(event) => onChange({ ...value, startDate: event.target.value })}
          />
          <input
            type="date"
            value={value.endDate}
            onChange={(event) => onChange({ ...value, endDate: event.target.value })}
          />
        </>
      ) : null}
    </div>
  );
}

function query(value: RangeState): string {
  const params = new URLSearchParams({ range: value.range });
  if (value.range === 'custom') {
    params.set('startDate', value.startDate);
    params.set('endDate', value.endDate);
  }
  return params.toString();
}
async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? 'Request failed.');
  return body;
}
function selectionRate(value: Pick<SourceAnalyticsRow, 'selected' | 'ignored'>): string {
  const rate = selectionRateValue(value);
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
function selectionRateValue(
  value: Pick<SourceAnalyticsRow, 'selected' | 'ignored'>,
): number | null {
  const denominator = value.selected + value.ignored;
  return denominator === 0 ? null : value.selected / denominator;
}
function ratio(success: number | null | undefined, selected: number | null | undefined): string {
  return success == null || selected == null ? 'N/A' : `${success} / ${selected}`;
}
function duration(value: number | null | undefined): string {
  return value == null
    ? 'N/A'
    : `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
}
function metric(value: number | null | undefined): string {
  return value == null ? 'N/A' : String(value);
}
