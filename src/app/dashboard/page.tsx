import { getDatabasePool } from "@/db/index.js";
import {
  getDashboardData,
  type DashboardContentCompletionMetrics,
  type DashboardStageMetrics,
} from "@/lib/dashboard.js";
import styles from "./dashboard.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGE_LABELS = {
  stage1: "Stage 1",
  stage2: "Stage 2",
  stage3: "Stage 3",
  stage4: "Stage 4",
} as const;

type DashboardPageProps = {
  searchParams: Promise<{ date?: string | string[] }>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const { date } = await searchParams;
  const detailDate = Array.isArray(date) ? date[0] : date;
  const data = await getDashboardData(getDatabasePool(), { detailDate });

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>X-AI-field · Internal</p>
          <h1 className={styles.title}>Daily Workflow Dashboard</h1>
          <p className={styles.subtitle}>
            最近 7 天 · 数据日期边界与 Daily Brief 一致（{data.timezone}）
          </p>
        </div>
        <div className={styles.today}>Today · {data.today}</div>
      </header>

      <section className={styles.summaryGrid} aria-label="Database totals">
        <SummaryCard label="Raw Articles" value={data.totals.rawArticles} />
        <SummaryCard label="Processed Contents" value={data.totals.processedContents} />
        <SummaryCard label="Events" value={data.totals.events} />
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.kicker}>Daily volume</p>
            <h2>最近 7 天</h2>
          </div>
          <p>DB 指标为业务数据；runtime 指标取各 Stage 当天最新一次 run。</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Raw Collected</th>
                <th>Stage1 Pending</th>
                <th>Stage1 Selected</th>
                <th>Ignored</th>
                <th>Failed</th>
                <th>Completion</th>
                <th>Backlog</th>
                <th>Completion Duration</th>
                <th>Stage1 Duration</th>
                <th>Processed Total</th>
                <th>Event</th>
                <th>Digest</th>
                <th>Long-form</th>
                <th>Inspiration</th>
                <th>Stage2 Groups</th>
                <th>Stage3 Selected Events</th>
                <th>Stage4 Events</th>
                <th>LLM Calls</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((day, index) => (
                <tr key={day.date} className={index === 0 ? styles.currentRow : undefined}>
                  <th scope="row">{day.date}</th>
                  <td>{formatNumber(day.raw.total)}</td>
                  <td>{formatNumber(day.raw.pending)}</td>
                  <td>{formatNumber(day.raw.selected)}</td>
                  <td>{formatNumber(day.raw.ignored)}</td>
                  <td>{formatNumber(day.raw.failed)}</td>
                  <td>{formatCompletion(day.runtime.contentCompletion)}</td>
                  <td>{formatMetric(day.runtime.contentCompletion?.remainingCount)}</td>
                  <td>{formatDuration(day.runtime.contentCompletion?.durationMs)}</td>
                  <td>{formatDuration(day.runtime.stages.stage1?.durationMs)}</td>
                  <td>{formatNumber(day.processed.total)}</td>
                  <td>{formatNumber(day.processed.event)}</td>
                  <td>{formatNumber(day.processed.digest)}</td>
                  <td>{formatNumber(day.processed.long_form)}</td>
                  <td>{formatNumber(day.processed.inspiration)}</td>
                  <td>{formatMetric(day.runtime.stages.stage2?.groupCount)}</td>
                  <td>{formatMetric(day.runtime.stages.stage3?.selectedEventCount)}</td>
                  <td>{formatNumber(day.events)}</td>
                  <td>{formatMetric(day.runtime.llmCalls)}</td>
                  <td>{formatMetric(day.runtime.inputTokens)}</td>
                  <td>{formatMetric(day.runtime.outputTokens)}</td>
                  <td>{formatDuration(day.runtime.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.details}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>Date details</p>
            <h2>{data.detailDate}</h2>
          </div>
          <form action="/dashboard" className={styles.dateForm}>
            <label htmlFor="dashboard-date">Select date</label>
            <input
              id="dashboard-date"
              name="date"
              type="date"
              defaultValue={data.detailDate}
            />
            <button type="submit">View</button>
          </form>
        </div>

        <div className={styles.detailGrid}>
          <CategoryPanel
            title="Processed by Category"
            counts={data.details.processedByCategory}
          />
          <CategoryPanel
            title="Digest by Category"
            counts={data.details.digestByCategory}
          />
        </div>

        <div className={styles.stageGrid}>
          <ContentCompletionCard metrics={data.details.contentCompletion} />
          {Object.entries(data.details.stages).map(([stage, metrics]) => (
            <StageCard
              key={stage}
              label={STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}
              metrics={metrics}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function ContentCompletionCard({
  metrics,
}: {
  metrics: DashboardContentCompletionMetrics | null;
}) {
  if (!metrics) {
    return (
      <article className={styles.stageCard}>
        <div className={styles.stageHeader}>
          <h3>Content Completion</h3>
          <span className={styles.naBadge}>N/A</span>
        </div>
        <p className={styles.empty}>No runtime artifact for this date.</p>
      </article>
    );
  }

  return (
    <article className={styles.stageCard}>
      <div className={styles.stageHeader}>
        <h3>Content Completion</h3>
        <StatusBadge status={metrics.status} />
      </div>
      <dl className={styles.metricList}>
        <Metric label="Candidates" value={formatMetric(metrics.candidateCount)} />
        <Metric label="Selected" value={formatMetric(metrics.selectedCount)} />
        <Metric label="Succeeded" value={formatMetric(metrics.successCount)} />
        <Metric label="Failed" value={formatMetric(metrics.failedCount)} />
        <Metric label="Remaining" value={formatMetric(metrics.remainingCount)} />
        <Metric label="Duration" value={formatDuration(metrics.durationMs)} />
        <Metric label="Limit" value={formatMetric(metrics.limit)} />
      </dl>
    </article>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <article className={styles.summaryCard}>
      <p>{label}</p>
      <strong>{formatNumber(value)}</strong>
      <span>database total</span>
    </article>
  );
}

function CategoryPanel({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <article className={styles.detailCard}>
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className={styles.empty}>No data for this date</p>
      ) : (
        <dl className={styles.countList}>
          {entries.map(([category, value]) => (
            <div key={category}>
              <dt>{category}</dt>
              <dd>{formatNumber(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function StageCard({
  label,
  metrics,
}: {
  label: string;
  metrics: DashboardStageMetrics | null;
}) {
  if (!metrics) {
    return (
      <article className={styles.stageCard}>
        <div className={styles.stageHeader}>
          <h3>{label}</h3>
          <span className={styles.naBadge}>N/A</span>
        </div>
        <p className={styles.empty}>No runtime artifact for this date.</p>
      </article>
    );
  }

  const stageMetrics = stageSpecificMetrics(metrics);
  return (
    <article className={styles.stageCard}>
      <div className={styles.stageHeader}>
        <h3>{label}</h3>
        <StatusBadge status={metrics.status} />
      </div>
      <dl className={styles.metricList}>
        <Metric label="Duration" value={formatDuration(metrics.durationMs)} />
        <Metric label="LLM duration" value={formatDuration(metrics.llmDurationMs)} />
        <Metric label="LLM calls" value={formatMetric(metrics.llmCalls)} />
        <Metric label="Retries" value={formatMetric(metrics.retryCount)} />
        <Metric label="Input tokens" value={formatMetric(metrics.inputTokens)} />
        <Metric label="Output tokens" value={formatMetric(metrics.outputTokens)} />
        <Metric label="Total tokens" value={formatMetric(metrics.totalTokens)} />
        {stageMetrics.map(([metricLabel, value]) => (
          <Metric key={metricLabel} label={metricLabel} value={formatMetric(value)} />
        ))}
      </dl>
    </article>
  );
}

function stageSpecificMetrics(metrics: DashboardStageMetrics): Array<[string, number | null]> {
  switch (metrics.stage) {
    case "stage1":
      return [];
    case "stage2":
      return [
        ["Candidates", metrics.candidateCount],
        ["Groups", metrics.groupCount],
      ];
    case "stage3":
      return [
        ["Event inputs", metrics.groupCount],
        ["Selected events", metrics.selectedEventCount],
        ["Digest before dedup", metrics.digestBeforeDedup],
        ["Digest after dedup", metrics.digestAfterDedup],
        ["Long-form", metrics.longFormCount],
      ];
    case "stage4":
      return [
        ["Selected input", metrics.selectedEventCount],
        ["Enrichment success", metrics.enrichmentSuccessCount],
        ["Enrichment failure", metrics.enrichmentFailureCount],
        ["Events created", metrics.eventsCreated],
      ];
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const normalized = status?.toLowerCase() ?? "unknown";
  const className =
    normalized === "success"
      ? styles.successBadge
      : normalized === "failed"
        ? styles.failedBadge
        : styles.naBadge;
  return <span className={className}>{status ?? "N/A"}</span>;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMetric(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : formatNumber(value);
}

function formatCompletion(
  metrics: DashboardContentCompletionMetrics | null,
): string {
  if (metrics?.successCount === null || metrics?.successCount === undefined) {
    return "N/A";
  }
  if (metrics.selectedCount === null) {
    return "N/A";
  }
  return `${formatNumber(metrics.successCount)} / ${formatNumber(metrics.selectedCount)}`;
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "N/A";
  }
  if (value < 1_000) {
    return `${value}ms`;
  }
  const seconds = value / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
