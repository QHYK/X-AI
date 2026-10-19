'use client';
// 负责导航交互与响应式展示

import NextLink from 'next/link.js';
import { usePathname, useSearchParams } from 'next/navigation.js';
import { Suspense, useState } from 'react';
import { adminNavigation, getActiveAdminHref } from '../admin-navigation.js';
import { AdminLogoutButton } from '../admin-logout-button.js';
import styles from './admin-layout.module.css';

// Next's CommonJS declarations expose an extra default level under NodeNext resolution.
const Link = NextLink as unknown as typeof NextLink.default;

type NavigationLinksProps = {
  pathname: string;
  onNavigate: () => void;
  date?: string | null;
};

function NavigationLinks({ pathname, onNavigate, date }: NavigationLinksProps) {
  const activeHref = getActiveAdminHref(pathname);
  return (
    <nav
      aria-label="后台主导航"
      className={styles.navigation}
    >
      {adminNavigation.map((group) => (
        <section
          key={group.label}
          className={styles.group}
        >
          <h2>{group.label}</h2>
          <ul>
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={
                    item.preserveDate && date ? { pathname: item.href, query: { date } } : item.href
                  }
                  aria-current={activeHref === item.href ? 'page' : undefined}
                  onClick={onNavigate}
                  prefetch={false}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function NavigationWithDate(props: NavigationLinksProps) {
  const params = useSearchParams();
  return (
    <NavigationLinks
      {...props}
      date={params.get('date')}
    />
  );
}

export function AdminSidebar() {
  // App Router's usePathname excludes basePath, so browser-relative URLs need only route depth.
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const relativeRoot =
    '../'.repeat(Math.max(0, pathname.split('/').filter(Boolean).length - 1)) || './';
  const close = () => setExpanded(false);

  return (
    <div className={styles.sidebarRegion}>
      <a
        href="#admin-content"
        className={styles.skipLink}
      >
        跳至内容
      </a>
      <div className={styles.mobileHeader}>
        <span>X-AI-field</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="admin-sidebar"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起导航' : '展开导航'}
        </button>
      </div>
      <aside
        id="admin-sidebar"
        aria-label="后台导航栏"
        className={`${styles.sidebar} ${expanded ? styles.expanded : ''}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <div className={styles.brand}>
          <span
            className={styles.brandMark}
            aria-hidden="true"
          >
            X
          </span>
          <div>
            <strong>X-AI-field</strong>
            <span>ADMIN WORKSPACE</span>
          </div>
        </div>
        <Suspense
          fallback={
            <NavigationLinks
              pathname={pathname}
              onNavigate={close}
            />
          }
        >
          <NavigationWithDate
            pathname={pathname}
            onNavigate={close}
          />
        </Suspense>
        <div className={styles.footer}>
          <span>管理员工作区</span>
          <AdminLogoutButton
            apiUrl={`${relativeRoot}api/auth/logout`}
            loginUrl={`${relativeRoot}login`}
          />
        </div>
      </aside>
    </div>
  );
}
