# MongoDB storage schema

Version 1. The dashboard in `query` mode reads exactly this. Any service that
writes these three collections in this shape (the bundled receiver, a BFF, a
collector exporter) works with it. `npm run conformance` checks a receiver
against this document.

Field names are camelCase. Ids are lowercase hex. Times are BSON `Date`
(millisecond precision) **plus** a decimal string with the original
nanoseconds, because OTLP timestamps are 64-bit nanoseconds.

Attributes are stored as arrays of `{ key, value }` pairs, so keys with dots
(`http.request.method`) stay plain strings and never become nested paths.
`value` is the decoded OTLP `AnyValue`: string, number (integers outside the
safe range stay strings), boolean, array or object.

## Shared fields

Present on `spans` and `events`. Values come from the record's attributes
first, then from its resource.

| Field | Type | From |
|---|---|---|
| `service` | string \| null | resource `service.name` |
| `serviceVersion` | string \| null | resource `service.version` |
| `environment` | string \| null | resource `deployment.environment.name` |
| `platform` | string \| null | resource `os.name`, else `os.type` |
| `deviceId` | string \| null | `device.id`, **or what the receiver authenticated** |
| `sessionId` | string \| null | `session.id` |
| `userId` | string \| null | `user.id`, **or what the receiver authenticated** |
| `screen` | string \| null | `app.screen.name` |
| `flow` | string \| null | `app.flow.name` |
| `flowInstanceId` | string \| null | `app.flow.instance_id` |
| `actionName` | string \| null | `app.action.name` |
| `actionInstanceId` | string \| null | `app.action.instance_id` |
| `outcome` | `success` \| `failure` \| `cancelled` \| `completed` \| null | `app.outcome` (other values: null) |
| `errorType` | string \| null | `error.type` |
| `source` | string \| null | `otel_flutter_bridge.source` (`dart` / `native`) |
| `resource` | `{key, value}[]` | the OTLP resource, as received |
| `scope` | `{ name, version }` | instrumentation scope |
| `receivedAt` | Date | when the receiver stored it |
| `expireAt` | Date | `receivedAt` + retention; TTL index |

## `spans`

One document per span.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `{service}:{traceId}:{spanId}`; resends are ignored |
| `traceId` | string | 32 hex |
| `spanId` | string | 16 hex |
| `parentSpanId` | string \| null | 16 hex; null for roots |
| `name` | string | |
| `kind` | number | OTLP `SpanKind`: 1 internal, 2 server, 3 client, 4 producer, 5 consumer |
| `start`, `end` | Date | |
| `startNs`, `endNs` | string | nanoseconds since epoch |
| `durationMs` | number | microsecond precision |
| `statusCode` | number | OTLP: 0 unset, 1 ok, 2 error |
| `statusMessage` | string \| null | |
| `attributes` | `{key, value}[]` | |
| `events` | `{ name, time, timeNs, attributes }[]` | span events |
| `links` | `{ traceId, spanId }[]` | |

Indexes: `{traceId: 1, start: 1}`, `{sessionId: 1, start: 1}`,
`{statusCode: 1, start: -1}`, TTL `{expireAt: 1}`.

## `events`

One document per OTLP log record (journey events).

| Field | Type | Notes |
|---|---|---|
| `_id` | string | stable digest of resource, scope and record; identical resends are ignored |
| `time` | Date | `time_unix_nano`, or `observed_time_unix_nano` when zero |
| `timeNs` | string | |
| `eventName` | string \| null | OTLP `event_name`, else attribute `event.name` |
| `severityNumber` | number | |
| `screenLabel`, `flowLabel`, `actionLabel` | string \| null | `app.*.label` |
| `durationMs` | number \| null | `app.duration_ms` |
| `traceId`, `spanId` | string \| null | null when the event happened outside a span |
| `attributes` | `{key, value}[]` | |

Indexes: `{sessionId: 1, time: 1}`, `{deviceId: 1, time: -1}`,
`{userId: 1, time: -1}`, `{traceId: 1}`, `{outcome: 1, time: -1}`, TTL
`{expireAt: 1}`.

## `sessions`

One summary per `session.id`, kept up to date by whoever writes `spans` and
`events`. Only **newly inserted** documents update it (a resend must not
count twice).

| Field | Type | Rule |
|---|---|---|
| `_id` | string | `session.id` |
| `deviceId` | string \| null | last non-null `deviceId` seen |
| `userIds` | string[] | `$addToSet` of non-null `userId` |
| `services`, `versions`, `platforms`, `environments` | string[] | `$addToSet` |
| `firstSeen` | Date | `$min` of event `time` / span `start` |
| `lastSeen` | Date | `$max` of event `time` / span `end` |
| `eventCount` | number | `$inc` per new event |
| `spanCount` | number | `$inc` per new span with a `sessionId` |
| `errorCount` | number | `$inc` per new event with `outcome: failure`, plus per new **root** span with `statusCode: 2` and no `actionInstanceId` (one per failed operation) |
| `expireAt` | Date | `$max` of the records' `expireAt`; TTL |

Indexes: `{lastSeen: -1}`, `{deviceId: 1, lastSeen: -1}`,
`{userIds: 1, lastSeen: -1}`, TTL `{expireAt: 1}`.

Spans and events without `sessionId` (for example backend spans of the same
trace) are stored and shown in traces, but do not touch `sessions`.

## Reads also filter expiry

TTL deletion runs about once a minute, so every query also filters
`expireAt > now`.
