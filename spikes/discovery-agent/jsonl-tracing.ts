import type { Span, SpanData, Trace, TracingProcessor } from '@openai/agents';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type TraceEvent = {
  event: 'trace_start' | 'trace_end' | 'span_start' | 'span_end';
  recorded_at: string;
  trace_id: string;
  span_id?: string;
  parent_span_id?: string | null;
  span_type?: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  error?: unknown;
  payload?: unknown;
};

export class JsonlTracingProcessor implements TracingProcessor {
  readonly filePath: string;
  private pending: TraceEvent[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async onTraceStart(trace: Trace): Promise<void> {
    this.pending.push(traceEvent('trace_start', trace));
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    this.pending.push(traceEvent('trace_end', trace));
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    this.pending.push(spanEvent('span_start', span));
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    this.pending.push(spanEvent('span_end', span));
  }

  async forceFlush(): Promise<void> {
    const events = this.pending.splice(0);
    if (events.length === 0) return;

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(
      this.filePath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

export function sanitizeSpanData(spanData: Record<string, unknown>): Record<string, unknown> {
  if (spanData.type === 'function') {
    return {
      type: spanData.type,
      name: spanData.name,
      input: summarizeFunctionInput(spanData.input),
      output: summarizeFunctionOutput(spanData.output),
    };
  }

  if (spanData.type === 'generation') {
    return {
      type: spanData.type,
      model: spanData.model,
      usage: spanData.usage,
      output_items: summarizeGenerationOutput(spanData.output),
    };
  }

  if (spanData.type === 'response') {
    const response = isRecord(spanData._response) ? spanData._response : {};
    return {
      type: spanData.type,
      response_id: spanData.response_id,
      model: response.model,
      status: response.status,
      usage: response.usage,
      tool_usage: response.tool_usage,
      output_items: summarizeGenerationOutput(response.output),
    };
  }

  return redact(spanData) as Record<string, unknown>;
}

function traceEvent(event: 'trace_start' | 'trace_end', trace: Trace): TraceEvent {
  return {
    event,
    recorded_at: new Date().toISOString(),
    trace_id: trace.traceId,
    payload: {
      name: trace.name,
      group_id: trace.groupId,
      metadata: redact(trace.metadata ?? {}),
    },
  };
}

function spanEvent(event: 'span_start' | 'span_end', span: Span<SpanData>): TraceEvent {
  return {
    event,
    recorded_at: new Date().toISOString(),
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentId,
    span_type: span.spanData.type,
    started_at: span.startedAt,
    ended_at: span.endedAt,
    duration_ms: durationMs(span.startedAt, span.endedAt),
    error: redact(span.error),
    payload: event === 'span_end' ? sanitizeSpanData(span.spanData) : undefined,
  };
}

function summarizeFunctionInput(value: unknown): unknown {
  const parsed = parseJson(value);
  if (isRecord(parsed) && typeof parsed.url === 'string') {
    return { url: parsed.url };
  }
  return '[redacted]';
}

function summarizeFunctionOutput(value: unknown): unknown {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return '[redacted]';

  return {
    url: parsed.url,
    status: parsed.status,
    content_length: parsed.content_length,
    returned_content_length: parsed.returned_content_length,
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
      output.action = redact(item.action);
    }
    return output;
  });
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  return new Date(endedAt).getTime() - new Date(startedAt).getTime();
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /authorization|api.?key|access.?token|refresh.?token/i.test(key) ? '***' : redact(nested),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
