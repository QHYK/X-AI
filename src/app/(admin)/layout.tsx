// 统一后台页面布局
import type { ReactNode } from 'react';
import { AdminSidebar } from './admin-sidebar.js';
import styles from './admin-layout.module.css';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.layout}>
      <AdminSidebar />
      <div
        className={styles.content}
        id="admin-content"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
