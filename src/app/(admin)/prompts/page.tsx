import { PromptManagement } from './prompt-management-client.js';
import styles from './prompts.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default function PromptManagementPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>X-AI-field · Administration</p>
        <h1>Prompt Management</h1>
        <p>查看版本、编辑 Draft，并明确选择生产使用的 Active Version。</p>
      </header>
      <PromptManagement />
    </main>
  );
}
