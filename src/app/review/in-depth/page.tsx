import { getDatabasePool } from '@/db/index.js';
import { resolveDailyScope } from '@/lib/daily-scope.js';
import { InDepthReviewStatusSchema, listInDepthReviewItems } from '@/lib/in-depth-reads.js';
import { InDepthReviewClient } from './review-client.js';
import { ReviewHeader } from '../review-header.js';
import styles from '../review.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InDepthReviewPage(props: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawStatus = Array.isArray(params.status) ? params.status[0] : params.status;
  const parsed = InDepthReviewStatusSchema.safeParse(rawStatus ?? 'pending');
  const status = parsed.success ? parsed.data : 'pending';
  const items = await listInDepthReviewItems(getDatabasePool(), status);

  return (
    <main className={styles.page}>
      <ReviewHeader
        title="In-depth Reads Review"
        description="Review and publish Discovery works. Approval makes a work visible immediately."
        dailyDate={resolveDailyScope(undefined).dailyDate}
        active="in-depth"
        showDateControl={false}
      />
      <InDepthReviewClient
        key={status}
        initialItems={items}
        status={status}
      />
    </main>
  );
}
