import { dashboardMetricDefinitions } from "@/lib/dashboard-metric-definitions.js";
import styles from "../dashboard.module.css";

export const dynamic = "force-static";

export default function DashboardMetricsPage() {
  return <main className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>X-AI-field · Internal</p><h1 className={styles.title}>Dashboard 指标说明</h1><p className={styles.subtitle}>说明当前指标的数据来源与统计口径；不修改 Dashboard 统计逻辑。</p></div><div className={styles.headerActions}><a href="/dashboard">返回 Dashboard</a></div></header>
    {dashboardMetricDefinitions.map((section) => <section className={styles.panel} key={section.title}><div className={styles.panelHeading}><div><p className={styles.kicker}>Metrics</p><h2>{section.title}</h2></div></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Metric</th><th>Source</th><th>Rule</th><th>Notes</th></tr></thead><tbody>{section.metrics.map((item) => <tr key={item.metric}><th scope="row">{item.metric}</th><td>{item.source}</td><td>{item.rule}</td><td>{item.notes}</td></tr>)}</tbody></table></div></section>)}
  </main>;
}
