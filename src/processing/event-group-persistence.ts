import type { Pool, PoolClient } from "pg";
import type { Stage2EventGroup } from "./stage2-job.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** 成功 Stage2 的完整替换快照；失败时旧快照不受影响。 */
export async function replaceEventGroups(
  pool: Pool,
  dailyDate: string,
  groups: Stage2EventGroup[],
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from event_groups where daily_date = $1::date`, [dailyDate]);
    const ids: string[] = [];
    for (const group of groups) {
      const members = group.sources.map((source) => source.processed_content_id).filter((id): id is string => Boolean(id));
      if (!members.length) continue;
      const inserted = await client.query<{ id: string }>(`insert into event_groups (daily_date, event_hint) values ($1::date, $2) returning id`, [dailyDate, group.event_hint]);
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Failed to persist Event Group.");
      await client.query(`insert into event_group_items (event_group_id, processed_content_id) select $1::uuid, unnest($2::uuid[])`, [id, members]);
      ids.push(id);
    }
    await client.query("commit");
    return ids;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function loadEventGroupsForRanking(queryable: Queryable, dailyDate: string) {
  const result = await queryable.query<{ eventGroupId:string; eventHint:string; processedContentId:string; source:string; title:string; summary:string | null }>(`
    select eg.id as "eventGroupId", eg.event_hint as "eventHint", egi.processed_content_id as "processedContentId", s.name as source, ra.title, pc.summary
    from event_groups eg join event_group_items egi on egi.event_group_id=eg.id
    join processed_contents pc on pc.id=egi.processed_content_id join raw_articles ra on ra.id=pc.raw_article_id join sources s on s.id=ra.source_id
    where eg.daily_date=$1::date order by eg.id, egi.processed_content_id`, [dailyDate]);
  return result.rows;
}
