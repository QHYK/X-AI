// D2–D4	
// 提供 Discovery 运行过程中的诊断与报告辅助能力
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type DiscoveryDiagnosticQueryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export async function recordDiscoveryDiagnostic(
  queryable: DiscoveryDiagnosticQueryable,
  input: {
    runId: string;
    name: string;
    status: 'success' | 'warning' | 'failed';
    payload: Record<string, unknown>;
    startedAt?: Date;
    endedAt?: Date;
  },
): Promise<void> {
  const startedAt = (input.startedAt ?? new Date()).toISOString();
  const endedAt = (input.endedAt ?? input.startedAt ?? new Date()).toISOString();
  await queryable.query(
    `insert into discovery_trace_spans (
        run_id, trace_id, span_id, span_type, name,
        started_at, ended_at, status, payload
      ) values (
        $1::uuid, $2, $3, 'custom', $4,
        $5::timestamptz, $6::timestamptz, $7, $8::jsonb
      )`,
    [
      input.runId,
      `discovery-run:${input.runId}`,
      randomUUID(),
      input.name,
      startedAt,
      endedAt,
      input.status,
      JSON.stringify(input.payload),
    ],
  );
}
