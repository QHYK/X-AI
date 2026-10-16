import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Span, SpanData, Trace, TracingProcessor } from '@openai/agents';

type PendingTraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanType: string;
  name: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: 'running' | 'success' | 'failed';
  payload: Record<string, unknown>;
};

export class PostgresDiscoveryTracingProcessor implements TracingProcessor {
  readonly traceIds = new Set<string>();
  private readonly pending = new Map<string, PendingTraceSpan>();
  private flushes = 0;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly runId: string,
  ) {}

  get flushCount(): number {
    return this.flushes;
  }

  async onTraceStart(trace: Trace): Promise<void> {
    this.traceIds.add(trace.traceId);
    this.pending.set(traceKey(trace.traceId), {
      traceId: trace.traceId,
      spanId: traceKey(trace.traceId),
      parentSpanId: null,
      spanType: 'trace',
      name: trace.name,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      payload: sanitizeRecord(trace.toJSON() ?? {}),
    });
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    const key = traceKey(trace.traceId);
    const prior = this.pending.get(key);
    this.pending.set(key, {
      traceId: trace.traceId,
      spanId: key,
      parentSpanId: null,
      spanType: 'trace',
      name: trace.name,
      startedAt: prior?.startedAt ?? null,
      endedAt: new Date().toISOString(),
      status: 'success',
      payload: sanitizeRecord(trace.toJSON() ?? {}),
    });
  }

  async onSpanStart(): Promise<void> {}

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    this.traceIds.add(span.traceId);
    this.pending.set(`${span.traceId}:${span.spanId}`, {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentId,
      spanType: span.spanData.type,
      name: readSpanName(span.spanData),
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      status: span.error ? 'failed' : 'success',
      payload: {
        data: sanitizeSpanData(span.spanData),
        error: sanitizeUnknown(span.error),
      },
    });
  }

  async forceFlush(): Promise<void> {
    const spans = [...this.pending.values()];
    this.pending.clear();
    if (spans.length === 0) return;
    this.flushes += 1;
    for (const span of spans) {
      await this.pool.query(
        `insert into discovery_trace_spans (
            id, run_id, trace_id, span_id, parent_span_id, span_type,
            name, started_at, ended_at, status, payload
          ) values (
            $1::uuid, $2::uuid, $3, $4, $5, $6,
            $7, $8::timestamptz, $9::timestamptz, $10, $11::jsonb
          )
          on conflict (trace_id, span_id) do update set
            parent_span_id = excluded.parent_span_id,
            span_type = excluded.span_type,
            name = excluded.name,
            started_at = coalesce(discovery_trace_spans.started_at, excluded.started_at),
            ended_at = excluded.ended_at,
            status = excluded.status,
            payload = excluded.payload`,
        [
          randomUUID(),
          this.runId,
          span.traceId,
          span.spanId,
          span.parentSpanId,
          span.spanType,
          span.name,
          span.startedAt,
          span.endedAt,
          span.status,
          JSON.stringify(span.payload),
        ],
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

export function sanitizeSpanData(spanData: Record<string, unknown>): Record<string, unknown> {
  if (spanData.type === 'function') {
    return {
      type: 'function',
      name: spanData.name,
      input: summarizeFunctionInput(spanData.input),
      output: summarizeFunctionOutput(spanData.output),
    };
  }
  if (spanData.type === 'generation') {
    return {
      type: 'generation',
      model: spanData.model,
      usage: sanitizeUnknown(spanData.usage),
      output_items: summarizeGenerationOutput(spanData.output),
    };
  }
  if (spanData.type === 'response') {
    const response = isRecord(spanData._response) ? spanData._response : {};
    return {
      type: 'response',
      response_id: spanData.response_id,
      model: response.model,
      status: response.status,
      usage: sanitizeUnknown(response.usage),
      tool_usage: sanitizeUnknown(response.tool_usage),
      output_items: summarizeGenerationOutput(response.output),
    };
  }
  return sanitizeRecord(spanData);
}

function summarizeFunctionInput(value: unknown): unknown {
  const parsed = parseJson(value);
  return isRecord(parsed) && typeof parsed.url === 'string' ? { url: parsed.url } : '[redacted]';
}

function summarizeFunctionOutput(value: unknown): unknown {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return '[redacted]';
  return {
    url: parsed.url,
    status: parsed.status,
    content_length: parsed.content_length,
    returned_content_length: parsed.returned_content_length,
    content_complete: parsed.content_complete,
    truncated: parsed.truncated,
    content_type: parsed.content_type,
    error: parsed.error,
  };
}

function summarizeGenerationOutput(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return { type: typeof item };
    const output: Record<string, unknown> = { type: item.type };
    if (typeof item.id === 'string') output.id = item.id;
    if (typeof item.status === 'string') output.status = item.status;
    if (item.type === 'web_search_call' && isRecord(item.action)) {
      output.action = sanitizeUnknown(item.action);
    }
    return output;
  });
}

function readSpanName(data: Record<string, unknown>): string | null {
  return typeof data.name === 'string'
    ? data.name
    : typeof data.type === 'string'
      ? data.type
      : null;
}

function traceKey(traceId: string): string {
  return `trace-root:${traceId}`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeRecord(value: object): Record<string, unknown> {
  return sanitizeUnknown(value) as Record<string, unknown>;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***');
  }
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /authorization|api.?key|access.?token|refresh.?token/i.test(key)
          ? '***'
          : sanitizeUnknown(nested),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
