import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { adminNavigation, getActiveAdminHref } from '../src/app/admin-navigation.js';

const items = adminNavigation.flatMap((group) => group.items);
assert.equal(items.length, 10);
assert.equal(new Set(items.map((item) => item.href)).size, items.length);

for (const item of items) {
  assert.ok(item.href.startsWith('/'));
  assert.ok(!item.href.includes('/ai') && !item.href.includes('(admin)'));
  assert.ok(existsSync(path.join('src/app/(admin)', item.href, 'page.tsx')), item.href);
  assert.equal(getActiveAdminHref(item.href), item.href);
  assert.equal(getActiveAdminHref(`${item.href}/detail`), item.href);
}

assert.equal(getActiveAdminHref('/dashboard/analytics'), '/dashboard/analytics');
assert.equal(getActiveAdminHref('/dashboard/metrics'), '/dashboard/metrics');
assert.equal(getActiveAdminHref('/review/events-extra'), undefined);
const review = adminNavigation.find((group) => group.label === 'Review')!;
const ignoredIndex = review.items.findIndex((item) => item.href === '/review/ignored');
assert.equal(review.items[ignoredIndex - 1]?.href, '/review/in-depth');
assert.equal(review.items[ignoredIndex + 1]?.href, '/review/models');
assert.equal(review.items[ignoredIndex]?.preserveDate, true);
for (const publicPath of ['/', '/login', '/in-depth']) {
  assert.equal(getActiveAdminHref(publicPath), undefined);
}

console.log('Admin navigation routes and most-specific active matching passed.');
