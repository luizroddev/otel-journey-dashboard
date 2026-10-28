// Client of the query API (docs/query-api.md).

export type Outcome = 'success' | 'failure' | 'cancelled' | 'completed';
export type FlowStatus = Outcome | 'open';
export type AttrValue = string | number | boolean | null | AttrValue[] | { [k: string]: AttrValue };
export interface Attr {
  key: string;
  value: AttrValue;
}

export interface SessionSummary {
  _id: string;
  /** Stamped by the receiver from what it authenticated; null otherwise. */
  deviceId: string | null;
  installationId: string | null;
  previousSessionId: string | null;
  userIds: string[];
  services: string[];
  versions: string[];
  platforms: string[];
  environments: string[];
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  spanCount: number;
  errorCount: number;
}

export interface SessionsPage {
  items: SessionSummary[];
  nextBefore: string | null;
  period: { from: string; to: string; clamped: boolean };
}

export type StepKind = 'session' | 'screen' | 'action' | 'flowStart' | 'flowEnd' | 'event';

export interface JourneyStep {
  id: string;
  time: string;
  timeNs: string;
  kind: StepKind;
  eventName: string | null;
  code: string | null;
  label: string | null;
  screen: string | null;
  flow: string | null;
  flowInstanceId: string | null;
  actionInstanceId: string | null;
  measured: boolean;
  outcome: Outcome | null;
  outcomeReason: string | null;
  durationMs: number | null;
  errorType: string | null;
  traceId: string | null;
  spanId: string | null;
  source: string | null;
  userId: string | null;
  previousSessionId: string | null;
  extra: Attr[];
}

export interface FlowRun {
  instanceId: string;
  code: string | null;
  label: string | null;
  start: string | null;
  end: string | null;
  status: FlowStatus;
  reason: string | null;
  durationMs: number | null;
  attempt: number;
  steps: number;
  failures: number;
}

export interface OtherTrace {
  traceId: string;
  name: string;
  start: string;
  durationMs: number;
  statusCode: number;
  screen: string | null;
}

export interface JourneyResponse {
  session: SessionSummary;
  steps: JourneyStep[];
  flows: FlowRun[];
  otherTraces: OtherTrace[];
  limits: { events: { loaded: number; truncated: boolean }; rootSpans: { loaded: number; truncated: boolean } };
}

export interface Span {
  _id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  start: string;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  service: string | null;
  source: string | null;
  sessionId: string | null;
  attributes: Attr[];
  events: { name: string; time: string; attributes: Attr[] }[];
  resource: Attr[];
}

export interface TraceResponse {
  traceId: string;
  rows: { span: Span; depth: number; missingParent: boolean; offsetMs: number }[];
  start: string | null;
  durationMs: number;
  services: string[];
  errorCount: number;
  missingParents: number;
  truncated: boolean;
  events: { _id: string; eventName: string | null; actionName: string | null; actionLabel: string | null; time: string }[];
}

export interface Facets {
  services: string[];
  versions: string[];
  platforms: string[];
  environments: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const token = () => localStorage.getItem('apiToken');

async function get<T>(path: string): Promise<T> {
  const t = token();
  const r = await fetch(`/api/${path}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      message = ((await r.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(r.status, message);
  }
  return (await r.json()) as T;
}

const qs = (o: Record<string, string | undefined | null | boolean>) =>
  new URLSearchParams(
    Object.entries(o).filter((e): e is [string, string | boolean] => e[1] !== undefined && e[1] !== null && e[1] !== '' && e[1] !== false).map(([k, v]) => [k, String(v)]),
  ).toString();

export const api = {
  sessions: (q: Record<string, string | undefined | boolean>) => get<SessionsPage>(`sessions?${qs(q)}`),
  journey: (id: string) => get<JourneyResponse>(`sessions/${encodeURIComponent(id)}/journey`),
  trace: (id: string) => get<TraceResponse>(`traces/${encodeURIComponent(id)}`),
  facets: (from: string, to: string) => get<Facets>(`facets?${qs({ from, to })}`),
};
