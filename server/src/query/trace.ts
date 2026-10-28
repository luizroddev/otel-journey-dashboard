// Builds the span tree of a trace as an ordered list with depth, flagging
// spans whose parent was never received. Pure.
import type { SpanDoc } from '../model.js';

export interface TraceRow {
  span: SpanDoc;
  depth: number;
  /** The span has a parent id, but that parent is not in the trace. */
  missingParent: boolean;
  /** Offset from the trace start, in milliseconds. */
  offsetMs: number;
}

export interface TraceView {
  traceId: string;
  rows: TraceRow[];
  start: string | null;
  durationMs: number;
  services: string[];
  errorCount: number;
  missingParents: number;
}

export function buildTrace(traceId: string, spans: SpanDoc[]): TraceView {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, SpanDoc[]>();
  const roots: SpanDoc[] = [];
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
    } else {
      roots.push(s);
    }
  }
  const startNs = spans.reduce<bigint | null>((m, s) => {
    const v = BigInt(s.startNs);
    return m === null || v < m ? v : m;
  }, null);
  const endNs = spans.reduce<bigint | null>((m, s) => {
    const v = BigInt(s.endNs);
    return m === null || v > m ? v : m;
  }, null);
  const byStart = (a: SpanDoc, b: SpanDoc) => {
    const d = BigInt(a.startNs) - BigInt(b.startNs);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  };

  const rows: TraceRow[] = [];
  const visit = (s: SpanDoc, depth: number) => {
    rows.push({
      span: s,
      depth,
      missingParent: !!s.parentSpanId && !byId.has(s.parentSpanId),
      offsetMs: startNs === null ? 0 : Number((BigInt(s.startNs) - startNs) / 1000n) / 1000,
    });
    for (const c of (children.get(s.spanId) ?? []).sort(byStart)) visit(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) visit(r, 0);

  return {
    traceId,
    rows,
    start: spans.length ? spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0]!.start).toISOString() : null,
    durationMs: startNs !== null && endNs !== null ? Number((endNs - startNs) / 1000n) / 1000 : 0,
    services: [...new Set(spans.map((s) => s.service).filter((v): v is string => !!v))],
    errorCount: spans.filter((s) => s.statusCode === 2).length,
    missingParents: rows.filter((r) => r.missingParent).length,
  };
}
