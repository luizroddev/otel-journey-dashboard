// Maps decoded OTLP into the stored documents (see model.ts). Pure, so the
// same rules can be tested and reimplemented by another receiver.
import { createHash } from 'node:crypto';
import type { Attr, AttrValue, CommonFields, EventDoc, Outcome, SpanDoc } from '../model.js';
import { Keys } from '../model.js';
import type { OtlpLogRecord, OtlpScope, OtlpSpan, ResourceGroup } from '../otlp/decode.js';

/** What the receiver knows about the sender, beyond the payload. */
export interface IngestIdentity {
  /**
   * The device the receiver authenticated (for example from a header it
   * checks). The only source of `deviceId`: the payload never sets it.
   */
  deviceId?: string | null;
  /** Overrides `user.id` from the payload. */
  userId?: string | null;
}

export interface MapOptions {
  now: Date;
  retentionDays: number;
  identity?: IngestIdentity;
}

const OUTCOMES = new Set<Outcome>(['success', 'failure', 'cancelled', 'completed']);

export function nsToDate(ns: string): Date {
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

function nsDiffMs(a: string, b: string): number {
  const d = BigInt(b) - BigInt(a);
  return d > 0n ? Number(d / 1000n) / 1000 : 0;
}

function lookup(list: Attr[]): (key: string) => AttrValue | undefined {
  const m = new Map(list.map((a) => [a.key, a.value]));
  return (k) => m.get(k);
}

function str(v: AttrValue | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.length ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function num(v: AttrValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function common(
  resource: Attr[],
  attributes: Attr[],
  scope: OtlpScope,
  opts: MapOptions,
): CommonFields {
  const r = lookup(resource);
  const a = lookup(attributes);
  const both = (k: string) => str(a(k)) ?? str(r(k));
  const outcome = str(a(Keys.outcome));
  const id = opts.identity;
  return {
    service: str(r(Keys.serviceName)),
    serviceVersion: str(r(Keys.serviceVersion)),
    environment: str(r(Keys.environment)),
    platform: str(r(Keys.osName)) ?? str(r(Keys.osType)),
    deviceId: id?.deviceId ?? null,
    installationId: str(r(Keys.installationId)),
    sessionId: both(Keys.sessionId),
    userId: id?.userId !== undefined ? id.userId : both(Keys.userId),
    screen: str(a(Keys.screen)),
    flow: str(a(Keys.flow)),
    flowInstanceId: str(a(Keys.flowInstanceId)),
    actionName: str(a(Keys.action)),
    actionInstanceId: str(a(Keys.actionInstanceId)),
    outcome: outcome && OUTCOMES.has(outcome as Outcome) ? (outcome as Outcome) : null,
    outcomeReason: str(a(Keys.outcomeReason)),
    errorType: str(a(Keys.errorType)),
    source: str(a(Keys.source)),
    resource,
    scope,
    receivedAt: opts.now,
    expireAt: new Date(opts.now.getTime() + opts.retentionDays * 86_400_000),
  };
}

export function mapSpans(groups: ResourceGroup<OtlpSpan>[], opts: MapOptions): SpanDoc[] {
  const out: SpanDoc[] = [];
  for (const g of groups) {
    for (const s of g.scopes) {
      for (const span of s.items) {
        if (!span.traceId || !span.spanId) continue;
        const c = common(g.resource, span.attributes, s.scope, opts);
        out.push({
          ...c,
          _id: `${c.service ?? ''}:${span.traceId}:${span.spanId}`,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: span.kind,
          start: nsToDate(span.startNs),
          end: nsToDate(span.endNs),
          startNs: span.startNs,
          endNs: span.endNs,
          durationMs: nsDiffMs(span.startNs, span.endNs),
          statusCode: span.statusCode,
          statusMessage: span.statusMessage,
          attributes: span.attributes,
          events: span.events.map((e) => ({ ...e, time: nsToDate(e.timeNs) })),
          links: span.links,
        });
      }
    }
  }
  return out;
}

export function mapLogs(groups: ResourceGroup<OtlpLogRecord>[], opts: MapOptions): EventDoc[] {
  const out: EventDoc[] = [];
  for (const g of groups) {
    for (const s of g.scopes) {
      for (const rec of s.items) {
        const c = common(g.resource, rec.attributes, s.scope, opts);
        const a = lookup(rec.attributes);
        const timeNs = rec.timeNs !== '0' ? rec.timeNs : rec.observedTimeNs;
        const uid = str(a(Keys.logRecordUid));
        out.push({
          ...c,
          _id: uid ? `${c.service ?? ''}:${uid}` : digest(g.resource, s.scope, rec),
          time: nsToDate(timeNs),
          timeNs,
          eventName: rec.eventName ?? str(a(Keys.eventName)),
          severityNumber: rec.severityNumber,
          screenLabel: str(a(Keys.screenLabel)),
          flowLabel: str(a(Keys.flowLabel)),
          actionLabel: str(a(Keys.actionLabel)),
          durationMs: num(a(Keys.durationMs)),
          traceId: rec.traceId,
          spanId: rec.spanId,
          attributes: rec.attributes,
        });
      }
    }
  }
  return out;
}

/** Id of a log record without `log.record.uid`: identical resends map to the same document. */
function digest(resource: Attr[], scope: OtlpScope, rec: OtlpLogRecord): string {
  return createHash('sha256')
    .update(JSON.stringify([resource, scope, rec]))
    .digest('hex')
    .slice(0, 40);
}
