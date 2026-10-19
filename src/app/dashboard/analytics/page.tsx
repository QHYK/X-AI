import { ContentAnalytics } from "./content-analytics.js";
import { AdminLogoutButton } from "../../admin-logout-button.js";
import styles from "../dashboard.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>X-AI-field · Internal</p>
        <h1 className={styles.title}>Content Analytics</h1>
        <p className={styles.subtitle}>Historical Daily Volume and source-level Stage 1 outcomes.</p>
      </div>
      <div className={styles.headerActions}>
        <a href="/dashboard">返回 Dashboard</a>
        <AdminLogoutButton apiUrl="../api/auth/logout" loginUrl="../login" />
      </div>
    </header>
    <ContentAnalytics />
  </main>;
}
