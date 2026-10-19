// 统一管理导航配置
export type AdminNavigationItem = {
  label: string;
  href: string;
  preserveDate?: boolean;
};

export type AdminNavigationGroup = {
  label: string;
  items: readonly AdminNavigationItem[];
};

/** The only menu inventory; href values are Next.js application paths without basePath. */
export const adminNavigation: readonly AdminNavigationGroup[] = [
  {
    label: 'Dashboard',
    items: [
      { label: 'Overview', href: '/dashboard' },
      { label: 'Analytics', href: '/dashboard/analytics' },
      { label: 'Metrics', href: '/dashboard/metrics' },
    ],
  },
  {
    label: 'Review',
    items: [
      { label: 'Events', href: '/review/events', preserveDate: true },
      { label: 'Long-form', href: '/review/long-form', preserveDate: true },
      { label: 'In-depth', href: '/review/in-depth' },
      { label: 'Model Evaluation', href: '/review/models', preserveDate: true },
    ],
  },
];

/** Prefer the most specific match so Overview is not active on Analytics or Metrics. */
export function getActiveAdminHref(pathname: string): string | undefined {
  return adminNavigation
    .flatMap((group) => group.items)
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}
