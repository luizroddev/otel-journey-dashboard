// Storage model. This is the MongoDB contract described in
// docs/storage-schema.md: any service that writes these collections in this
// shape (for example a BFF) can be read by the dashboard in `query` mode.

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
  resource: Attr[];
  scope: { name: string | null; version: string | null };
  receivedAt: Date;
  expireAt: Date;
}

export type Outcome = 'success' | 'failure' | 'cancelled' | 'completed';

/** Collection `spans`. `_id` = `{service}:{traceId}:{spanId}`. */
export interface SpanDoc extends CommonFields {
  _id: string;
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
  attributes: Attr[];
}

/** Collection `sessions`: one summary per `session.id`, kept by ingestion. */
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
  expireAt: Date;
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
} as const;

export const EventNames = {
  sessionStart: 'session.start',
  screenView: 'journey.screen.view',
  action: 'journey.action',
  flowStart: 'journey.flow.start',
  flowEnd: 'journey.flow.end',
} as const;
