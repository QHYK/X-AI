// D3/5
// 采集 Agent 执行过程中的 Trace，包括模型调用、工具调用和 Token Usage
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Span, SpanData, Trace, TracingProcessor } from '@openai/agents';
import type { DiscoveryStageUsage } from '../db/schema.js';
import {
  emptyDiscoveryStageUsage,
  mergeDiscoveryStageUsage,
  usageFromAgentResponseUsage,
} from './execution-diagnostics.js';

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
  private flushing: Promise<void> | null = null;
  private closed = false;
  private dropped = 0;
  private static readonly MAX_PENDING = 1000;

  get traceFlushed(): boolean {
    return this.pending.size === 0 && this.dropped === 0;
  }

  private buffer(key: string, span: PendingTraceSpan): void {
    if (this.closed) return;
    if (
      !this.pending.has(key) &&
      this.pending.size >= PostgresDiscoveryTracingProcessor.MAX_PENDING
    ) {
      this.dropped++;
      if (this.dropped === 1)
        console.error('Discovery Trace buffer limit reached; dropping new spans.', {
          runId: this.runId,
          limit: PostgresDiscoveryTracingProcessor.MAX_PENDING,
        });
      return;
    }
    this.pending.set(key, span);
  }
  private usage: DiscoveryStageUsage = emptyDiscoveryStageUsage();

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly runId: string,
  ) {}

  get flushCount(): number {
    return this.flushes;
  }

  /** Response spans are the one-to-one source for D3 model request accounting. */
  getUsage(): DiscoveryStageUsage {
    return { ...this.usage };
  }

  async onTraceStart(trace: Trace): Promise<void> {
    if (this.closed) return;
    if (this.traceIds.size < PostgresDiscoveryTracingProcessor.MAX_PENDING)
      this.traceIds.add(trace.traceId);
    this.buffer(traceKey(trace.traceId), {
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
    this.buffer(key, {
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
    if (this.closed) return;
    if (this.traceIds.size < PostgresDiscoveryTracingProcessor.MAX_PENDING)
      this.traceIds.add(span.traceId);
    if (span.spanData.type === 'response') {
      const responseData = span.spanData as unknown as Record<string, unknown>;
      const response = isRecord(responseData._response) ? responseData._response : null;
      this.usage = mergeDiscoveryStageUsage(
        this.usage,
        usageFromAgentResponseUsage(response?.usage),
      );
    }
    this.buffer(`${span.traceId}:${span.spanId}`, {
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
    // SDK and explicit shutdown may flush concurrently; serialize writes and preserve newer updates.
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPending();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async flushPending(): Promise<void> {
    const spans = [...this.pending.entries()];
    if (spans.length === 0) return;
    this.flushes += 1;
    for (const [key, span] of spans) {
      try {
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
        if (this.pending.get(key) === span) this.pending.delete(key);
      } catch (error) {
        console.error('Discovery Trace persistence failed; spans retained for next flush.', {
          runId: this.runId,
          traceId: span.traceId,
          spanId: span.spanId,
          pendingCount: this.pending.size,
          error: sanitizeUnknown(error instanceof Error ? error.message : String(error)),
        });
        break;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.forceFlush();
    this.closed = true;
    if (this.pending.size || this.dropped) {
      console.error('Discovery Trace shutdown discarded unwritten spans.', {
        runId: this.runId,
        pendingCount: this.pending.size,
        droppedCount: this.dropped,
      });
      this.dropped += this.pending.size;
      this.pending.clear();
    }
  }
}

/** Diagnostics must never replace a successful Agent result or its original business error. */
export async function finishDiscoveryTrace(
  processor: PostgresDiscoveryTracingProcessor,
  flushProvider: () => Promise<void>,
): Promise<boolean> {
  let providerFlushed = true;
  try {
    await flushProvider();
  } catch (error) {
    providerFlushed = false;
    console.error('Discovery SDK Trace flush failed.', {
      error: sanitizeUnknown(error instanceof Error ? error.message : String(error)),
    });
  }
  try {
    await processor.shutdown();
  } catch (error) {
    console.error('Discovery Trace shutdown failed.', {
      error: sanitizeUnknown(error instanceof Error ? error.message : String(error)),
    });
    return false;
  }
  return providerFlushed && processor.traceFlushed;
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
