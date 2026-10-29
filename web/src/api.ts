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
  flows: string[];
  failures: { kind: 'flow' | 'action'; code: string; reason: string | null; errorType: string | null }[];
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
  flows: string[];
}

export interface Rate {
  n: number;
  failure: number;
}

export interface ReasonCount {
  outcome: Outcome;
  reason: string | null;
  errorType: string | null;
  now: number;
  before: number;
}

export interface FlowStat {
  code: string;
  label: string | null;
  started: number;
  success: number;
  failure: number;
  cancelled: number;
  completed: number;
  open: number;
  p95Ms: number | null;
  before: { started: number; failure: number; open: number; p95Ms: number | null };
  series: { started: number[]; failure: number[]; ended: number[] };
  reasons: ReasonCount[];
  byVersion: { version: string | null; platform: string | null; started: number; failure: number; before: Rate; series: { started: number[]; failure: number[] } }[];
}

export interface ActionStat {
  code: string;
  label: string | null;
  n: number;
  failure: number;
  measured: number;
  p95Ms: number | null;
  before: { n: number; failure: number; measured: number; p95Ms: number | null };
}

export interface VersionStat {
  version: string | null;
  platform: string | null;
  sessions: number;
  failedSessions: number;
  before: { sessions: number; failedSessions: number };
  flows: Record<string, Rate>;
}

export type Change =
  | {
      type: 'failure';
      direction: 'worse' | 'better';
      code: string;
      label: string | null;
      now: Rate;
      before: Rate;
      since: string | null;
      where: { version: string | null; platform: string | null; share: number } | null;
      reason: { reason: string | null; errorType: string | null; shareBefore: number; shareNow: number; beforeScope: 'version' | 'flow' } | null;
      impact: number;
    }
  | { type: 'duration'; direction: 'worse' | 'better'; code: string; label: string | null; nowMs: number; beforeMs: number; measured: number; impact: number };

export type PeriodKey = '24h' | '7d' | '30d';

export interface Overview {
  period: { key: PeriodKey; from: string; to: string };
  previous: { key: 'previous' | 'week'; from: string; to: string };
  slot: 'hour' | 'day';
  slots: string[];
  updatedAt: string | null;
  minVolume: number;
  sessions: { now: number; before: number; series: number[] };
  failedSessions: { now: number; before: number; series: number[] };
  flows: FlowStat[];
  actions: ActionStat[];
  versions: VersionStat[];
  changes: Change[];
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
  overview: (q: Record<string, string | undefined>) => get<Overview>(`overview?${qs(q)}`),
  status: () => get<{ aggregatedUpTo: string | null }>('status'),
};
