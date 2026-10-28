// Decodes OTLP/HTTP requests (protobuf or JSON) into one normalized shape:
// ids as lowercase hex, nanosecond timestamps as decimal strings, attributes
// as plain values. Uses the official .proto files in server/proto.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import protobuf from 'protobufjs';
import type { Attr, AttrValue } from '../model.js';

export interface OtlpScope {
  name: string | null;
  version: string | null;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startNs: string;
  endNs: string;
  attributes: Attr[];
  events: { name: string; timeNs: string; attributes: Attr[] }[];
  links: { traceId: string; spanId: string }[];
  statusCode: number;
  statusMessage: string | null;
}

export interface OtlpLogRecord {
  timeNs: string;
  observedTimeNs: string;
  severityNumber: number;
  eventName: string | null;
  traceId: string | null;
  spanId: string | null;
  attributes: Attr[];
}

export interface ResourceGroup<T> {
  resource: Attr[];
  scopes: { scope: OtlpScope; items: T[] }[];
}

type Encoding = 'protobuf' | 'json';

function protoDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../proto'),
    path.resolve(here, '../../../../server/proto'),
    path.resolve(process.cwd(), 'server/proto'),
  ];
  const found = candidates.find((d) => existsSync(path.join(d, 'opentelemetry')));
  if (!found) throw new Error('OTLP .proto files not found (server/proto)');
  return found;
}

let root: protobuf.Root | undefined;
function types() {
  if (!root) {
    const dir = protoDir();
    root = new protobuf.Root();
    root.resolvePath = (_origin, target) => path.join(dir, target);
    root.loadSync([
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      'opentelemetry/proto/collector/logs/v1/logs_service.proto',
    ]);
  }
  return {
    traces: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'),
    logs: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest'),
    traceResponse: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse'),
    logsResponse: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse'),
    root,
  };
}

/** The protobuf types, for tests and scripts that build requests. */
export function otlpTypes() {
  return types();
}

/** Empty success response bodies. */
export function successBody(signal: 'traces' | 'logs', encoding: Encoding): Uint8Array | string {
  if (encoding === 'json') return '{}';
  const t = signal === 'traces' ? types().traceResponse : types().logsResponse;
  return t.encode(t.create({})).finish();
}

const toObjectOptions: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String, // base64
  defaults: false,
  arrays: true,
};

/** Raw decoded object, before normalization. */
function decodeRaw(signal: 'traces' | 'logs', body: Uint8Array | string, encoding: Encoding): any {
  if (encoding === 'json') {
    return typeof body === 'string' ? JSON.parse(body) : JSON.parse(Buffer.from(body).toString('utf8'));
  }
  const t = signal === 'traces' ? types().traces : types().logs;
  return t.toObject(t.decode(body as Uint8Array), toObjectOptions);
}

export function decodeTraces(body: Uint8Array | string, encoding: Encoding): ResourceGroup<OtlpSpan>[] {
  const raw = decodeRaw('traces', body, encoding);
  const id = idReader(encoding);
  return (raw.resourceSpans ?? []).map((rs: any) => ({
    resource: attrs(rs.resource?.attributes),
    scopes: (rs.scopeSpans ?? []).map((ss: any) => ({
      scope: scope(ss.scope),
      items: (ss.spans ?? []).map(
        (s: any): OtlpSpan => ({
          traceId: id(s.traceId) ?? '',
          spanId: id(s.spanId) ?? '',
          parentSpanId: id(s.parentSpanId),
          name: String(s.name ?? ''),
          kind: enumNumber(s.kind, SPAN_KINDS),
          startNs: nanos(s.startTimeUnixNano),
          endNs: nanos(s.endTimeUnixNano),
          attributes: attrs(s.attributes),
          events: (s.events ?? []).map((e: any) => ({
            name: String(e.name ?? ''),
            timeNs: nanos(e.timeUnixNano),
            attributes: attrs(e.attributes),
          })),
          links: (s.links ?? [])
            .map((l: any) => ({ traceId: id(l.traceId) ?? '', spanId: id(l.spanId) ?? '' }))
            .filter((l: { traceId: string }) => l.traceId),
          statusCode: enumNumber(s.status?.code, STATUS_CODES),
          statusMessage: s.status?.message ? String(s.status.message) : null,
        }),
      ),
    })),
  }));
}

export function decodeLogs(body: Uint8Array | string, encoding: Encoding): ResourceGroup<OtlpLogRecord>[] {
  const raw = decodeRaw('logs', body, encoding);
  const id = idReader(encoding);
  return (raw.resourceLogs ?? []).map((rl: any) => ({
    resource: attrs(rl.resource?.attributes),
    scopes: (rl.scopeLogs ?? []).map((sl: any) => ({
      scope: scope(sl.scope),
      items: (sl.logRecords ?? []).map(
        (r: any): OtlpLogRecord => ({
          timeNs: nanos(r.timeUnixNano),
          observedTimeNs: nanos(r.observedTimeUnixNano),
          severityNumber: enumNumber(r.severityNumber, {}),
          eventName: r.eventName ? String(r.eventName) : null,
          traceId: id(r.traceId),
          spanId: id(r.spanId),
          attributes: attrs(r.attributes),
        }),
      ),
    })),
  }));
}

/** Counts spans or log records in decoded groups. */
export function countItems(groups: ResourceGroup<unknown>[]): number {
  return groups.reduce((n, g) => n + g.scopes.reduce((m, s) => m + s.items.length, 0), 0);
}

const SPAN_KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const STATUS_CODES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function enumNumber(v: unknown, names: Record<string, number>): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return names[v] ?? (Number.isFinite(Number(v)) ? Number(v) : 0);
  return 0;
}

/** OTLP JSON carries ids as hex; protobuf (decoded above) as base64. */
function idReader(encoding: Encoding) {
  return (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0) return null;
    const hex = encoding === 'json' ? v.toLowerCase() : Buffer.from(v, 'base64').toString('hex');
    return /^0+$/.test(hex) ? null : hex;
  };
}

function nanos(v: unknown): string {
  if (v === undefined || v === null || v === '') return '0';
  return BigInt(String(v)).toString();
}

function scope(s: any): OtlpScope {
  return { name: s?.name ? String(s.name) : null, version: s?.version ? String(s.version) : null };
}

function attrs(list: any[] | undefined): Attr[] {
  return (list ?? []).map((kv) => ({ key: String(kv.key ?? ''), value: anyValue(kv.value) }));
}

function anyValue(v: any): AttrValue {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return String(v.stringValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in v) {
    const out: Record<string, AttrValue> = {};
    for (const kv of v.kvlistValue?.values ?? []) out[String(kv.key)] = anyValue(kv.value);
    return out;
  }
  if ('bytesValue' in v) return String(v.bytesValue);
  return null;
}
