import { MemoryManagement } from './memory-management.js';
import styles from './memories.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function MemoryPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p>X-AI-field · Administration</p>
        <h1>Memory</h1>
      </header>
      <MemoryManagement />
    </main>
  );
}
