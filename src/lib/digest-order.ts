import type { Pool, PoolClient } from 'pg';
type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Short transaction-only lock shared by automatic ranking and manual append. */
// 给排名写入加一个数据库事务锁，由 Put Back 和 Stage3 共用。
// 例如两篇文章同时恢复，如果都读到当前最大排名是 10，就可能都写入 11。这个锁让它们依次完成排名写入，得到 11、12。
export async function lockDigestOrder(db: Queryable): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended('digest-display-order', 0))");
}
