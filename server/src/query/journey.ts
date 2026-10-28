// Builds the journey of a session from its events: ordered steps, flow runs
// with their attempts, and traces not linked to any step. Pure.
import type { Attr, EventDoc, Outcome, SpanDoc } from '../model.js';
import { EventNames } from '../model.js';

export type StepKind = 'screen' | 'action' | 'flowStart' | 'flowEnd' | 'event';

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
  /** Measured actions (`Journey.track`) have a duration and a trace. */
  measured: boolean;
  outcome: Outcome | null;
  durationMs: number | null;
  errorType: string | null;
  traceId: string | null;
  spanId: string | null;
  source: string | null;
  userId: string | null;
  /** App attributes beyond the journey contract (`app.login.method`, ...). */
  extra: Attr[];
}

export type FlowStatus = Outcome | 'open';

export interface FlowRunView {
  instanceId: string;
  code: string | null;
  label: string | null;
  start: string | null;
  end: string | null;
  /** `open` = started, no end received: no conclusion, not "abandoned". */
  status: FlowStatus;
  durationMs: number | null;
  /** 1 for the first run of this flow in the session, 2 for the next... */
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

export interface JourneyView {
  steps: JourneyStep[];
  flows: FlowRunView[];
  otherTraces: OtherTrace[];
}

const CONTRACT_KEYS = new Set([
  'event.name',
  'session.id',
  'user.id',
  'device.id',
  'otel_flutter_bridge.source',
  'app.screen.name',
  'app.screen.label',
  'app.flow.name',
  'app.flow.label',
  'app.flow.instance_id',
  'app.action.name',
  'app.action.label',
  'app.action.instance_id',
  'app.outcome',
  'app.duration_ms',
  'error.type',
]);

function kindOf(name: string | null): StepKind {
  switch (name) {
    case EventNames.screenView:
      return 'screen';
    case EventNames.action:
      return 'action';
    case EventNames.flowStart:
      return 'flowStart';
    case EventNames.flowEnd:
      return 'flowEnd';
    default:
      return 'event';
  }
}

export function toStep(e: EventDoc): JourneyStep {
  const kind = kindOf(e.eventName);
  const code =
    kind === 'screen' ? e.screen : kind === 'action' ? e.actionName : kind === 'event' ? e.eventName : e.flow;
  const label = kind === 'screen' ? e.screenLabel : kind === 'action' ? e.actionLabel : kind === 'event' ? null : e.flowLabel;
  return {
    id: e._id,
    time: e.time.toISOString(),
    timeNs: e.timeNs,
    kind,
    eventName: e.eventName,
    code,
    label,
    screen: e.screen,
    flow: e.flow,
    flowInstanceId: e.flowInstanceId,
    actionInstanceId: e.actionInstanceId,
    measured: kind === 'action' && e.durationMs !== null && !!e.traceId,
    outcome: e.outcome,
    durationMs: e.durationMs,
    errorType: e.errorType,
    traceId: e.traceId,
    spanId: e.spanId,
    source: e.source,
    userId: e.userId,
    extra: e.attributes.filter((a) => !CONTRACT_KEYS.has(a.key)),
  };
}

function compareNs(a: string, b: string): number {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

// On equal timestamps a flow starts before what happens in it and ends after.
const TIE: Record<StepKind, number> = { flowStart: 0, screen: 1, action: 1, event: 1, flowEnd: 2 };

export function buildJourney(events: EventDoc[], rootSpans: SpanDoc[]): JourneyView {
  const steps = events
    .map(toStep)
    .sort((a, b) => compareNs(a.timeNs, b.timeNs) || TIE[a.kind] - TIE[b.kind]);

  const runs = new Map<string, FlowRunView>();
  const order: string[] = [];
  const run = (id: string, s: JourneyStep): FlowRunView => {
    let r = runs.get(id);
    if (!r) {
      r = {
        instanceId: id,
        code: s.flow,
        label: null,
        start: null,
        end: null,
        status: 'open',
        durationMs: null,
        attempt: 0,
        steps: 0,
        failures: 0,
      };
      runs.set(id, r);
      order.push(id);
    }
    return r;
  };
  for (const s of steps) {
    if (!s.flowInstanceId) continue;
    const r = run(s.flowInstanceId, s);
    r.code ??= s.flow;
    if (s.kind === 'flowStart') {
      r.start = s.time;
      r.label ??= s.label;
    } else if (s.kind === 'flowEnd') {
      r.end = s.time;
      r.label ??= s.label;
      r.status = s.outcome ?? 'completed';
      r.durationMs = s.durationMs;
    } else {
      r.steps++;
      if (s.outcome === 'failure') r.failures++;
    }
    r.start ??= s.time;
  }
  const seen = new Map<string, number>();
  const flows = order.map((id) => {
    const r = runs.get(id)!;
    const key = r.code ?? '';
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    r.attempt = n;
    return r;
  });

  const linked = new Set(steps.map((s) => s.traceId).filter((t): t is string => !!t));
  const otherTraces = rootSpans
    .filter((s) => !linked.has(s.traceId))
    .map((s) => ({
      traceId: s.traceId,
      name: s.name,
      start: s.start.toISOString(),
      durationMs: s.durationMs,
      statusCode: s.statusCode,
      screen: s.screen,
    }));

  return { steps, flows, otherTraces };
}
