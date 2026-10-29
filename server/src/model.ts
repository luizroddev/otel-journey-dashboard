// Storage model. This is the MongoDB contract described in
// docs/storage-schema.md. Writers (the bundled receiver, or a BFF) only
// insert `spans` and `events`; the dashboard derives `sessions` and
// `rollups` from them.

/** A JSON value decoded from an OTLP AnyValue. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | AttrValue[]
  | { [key: string]: AttrValue };

/** One attribute, kept as a pair so keys with dots stay plain strings. */
export interface Attr {
  key: string;
  value: AttrValue;
}

/** Fields every stored record shares, projected from resource and attributes. */
export interface CommonFields {
  service: string | null;
  serviceVersion: string | null;
  environment: string | null;
  platform: string | null;
  /** `device.id` stamped by the receiver from what it authenticated; never read from the payload. */
  deviceId: string | null;
  /** `app.installation.id` from the resource: one installation of the app. */
  installationId: string | null;
  sessionId: string | null;
  userId: string | null;
  screen: string | null;
  flow: string | null;
  flowInstanceId: string | null;
  actionName: string | null;
  actionInstanceId: string | null;
  outcome: Outcome | null;
  /** `journey.outcome_reason`: why it ended that way, a fixed code from the app. */
  outcomeReason: string | null;
  errorType: string | null;
  source: string | null;
  scope: { name: string | null; version: string | null };
  receivedAt: Date;
  expireAt: Date;
}

export type Outcome = 'success' | 'failure' | 'cancelled' | 'completed';

/** Collection `spans`. `_id` = `{service}:{traceId}:{spanId}`. */
export interface SpanDoc extends CommonFields {
  _id: string;
  /** Resource attributes without the projected ones (`service.name`, ...). */
  resource: Attr[];
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTLP SpanKind number (1 internal, 2 server, 3 client, ...). */
  kind: number;
  start: Date;
  end: Date;
  /** Nanoseconds since epoch, as a decimal string (64-bit safe). */
  startNs: string;
  endNs: string;
  durationMs: number;
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  statusCode: number;
  statusMessage: string | null;
  attributes: Attr[];
  events: { name: string; time: Date; timeNs: string; attributes: Attr[] }[];
  links: { traceId: string; spanId: string }[];
}

/**
 * Collection `events` (OTLP log records). `_id` = `{service}:{log.record.uid}`,
 * or a digest of the record when it has no uid.
 */
export interface EventDoc extends CommonFields {
  _id: string;
  time: Date;
  timeNs: string;
  eventName: string | null;
  severityNumber: number;
  screenLabel: string | null;
  flowLabel: string | null;
  actionLabel: string | null;
  durationMs: number | null;
  traceId: string | null;
  spanId: string | null;
  /** Attributes without the projected ones. */
  attributes: Attr[];
}

/** A failure seen in a session: what failed and why. */
export interface SessionFailure {
  kind: 'flow' | 'action';
  code: string;
  reason: string | null;
  errorType: string | null;
}

/** Collection `sessions`: one summary per `session.id`, derived by the aggregator. */
export interface SessionDoc {
  _id: string;
  deviceId: string | null;
  installationId: string | null;
  /** `session.previous_id` of its `session.start`: the session this one follows. */
  previousSessionId: string | null;
  userIds: string[];
  services: string[];
  versions: string[];
  platforms: string[];
  environments: string[];
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  spanCount: number;
  errorCount: number;
  /** Codes of the flows started in the session. */
  flows: string[];
  /** Failed flow runs and actions, for drill-down from the overview. */
  failures: SessionFailure[];
  /** Upper bound of the last aggregation chunk applied (idempotency guard). */
  upTo: Date;
  expireAt: Date;
}

export type RollupKind = 'session' | 'flow' | 'action';

/**
 * Collection `rollups`: counters per hour and dimension, derived by the
 * aggregator. Counters are absent when zero.
 */
export interface RollupDoc {
  /** JSON of `[hour, service, version, platform, environment, kind, code]`. */
  _id: string;
  hour: Date;
  service: string | null;
  version: string | null;
  platform: string | null;
  environment: string | null;
  kind: RollupKind;
  /** Flow or action code; empty for `session`. */
  code: string;
  label?: string | null;
  /** Sessions started, flow runs started, or actions. */
  n?: number;
  /** Results. Flow runs count in the hour they started. */
  success?: number;
  failure?: number;
  cancelled?: number;
  completed?: number;
  /** `session`: sessions whose first failure happened in this hour. */
  failed?: number;
  /** `reasons.{outcome}.{reason}`: `journey.outcome_reason` per result (keys escaped). */
  reasons?: Partial<Record<Outcome, Record<string, number>>>;
  /** `errors.{error.type}`: failures without a reason (keys escaped). */
  errors?: Record<string, number>;
  /** Duration histogram: index into DURATION_BOUNDS_MS, count. */
  dur?: Record<string, number>;
  upTo: Date;
  expireAt: Date;
}

/**
 * Upper bounds, in milliseconds, of the duration histogram buckets of
 * `rollups.dur`. The last bucket has no upper bound.
 */
export const DURATION_BOUNDS_MS = [
  50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
  600_000,
] as const;

/** Collection `jobs`: state of the aggregator. */
export interface JobDoc {
  _id: string;
  /** Everything received up to this instant is aggregated. */
  done?: Date;
  /** A chunk that started and may not have finished: redone first. */
  pending?: Date | null;
  owner?: string;
  leaseUntil?: Date;
}

/** Attribute keys of the journey contract, version 2 (otel_flutter_bridge docs/specs/journey.md). */
export const Keys = {
  serviceName: 'service.name',
  serviceVersion: 'service.version',
  environment: 'deployment.environment.name',
  osName: 'os.name',
  osType: 'os.type',
  installationId: 'app.installation.id',
  sessionId: 'session.id',
  sessionPreviousId: 'session.previous_id',
  userId: 'user.id',
  eventName: 'event.name',
  logRecordUid: 'log.record.uid',
  screen: 'app.screen.name',
  screenLabel: 'journey.screen.label',
  flow: 'journey.flow.name',
  flowLabel: 'journey.flow.label',
  flowInstanceId: 'journey.flow.instance_id',
  flowParentInstanceId: 'journey.flow.parent_instance_id',
  action: 'journey.action.name',
  actionLabel: 'journey.action.label',
  actionInstanceId: 'journey.action.instance_id',
  outcome: 'journey.outcome',
  outcomeReason: 'journey.outcome_reason',
  durationMs: 'journey.duration_ms',
  errorType: 'error.type',
  source: 'otel_flutter_bridge.source',
  iosAppState: 'ios.app.state',
  androidAppState: 'android.app.state',
} as const;

/** Keys stored as fields of `spans` and `events`. */
const projected = [
  Keys.serviceName,
  Keys.serviceVersion,
  Keys.environment,
  Keys.osName,
  Keys.osType,
  Keys.installationId,
  Keys.sessionId,
  Keys.userId,
  Keys.screen,
  Keys.flow,
  Keys.flowInstanceId,
  Keys.action,
  Keys.actionInstanceId,
  Keys.outcome,
  Keys.outcomeReason,
  Keys.errorType,
  Keys.source,
];

/**
 * Keys that writers leave out of `attributes` and `resource`, because a field
 * holds them (lean documents). Events also project the labels, the duration
 * and the event name; `log.record.uid` lives in their `_id`.
 */
export const ProjectedKeys = {
  spans: new Set<string>(projected),
  events: new Set<string>([
    ...projected,
    Keys.eventName,
    Keys.logRecordUid,
    Keys.screenLabel,
    Keys.flowLabel,
    Keys.actionLabel,
    Keys.durationMs,
  ]),
};

export const EventNames = {
  sessionStart: 'session.start',
  screenView: 'journey.screen.view',
  action: 'journey.action',
  flowStart: 'journey.flow.start',
  flowEnd: 'journey.flow.end',
  appLifecycle: 'device.app.lifecycle',
} as const;
