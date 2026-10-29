# MongoDB storage schema

Version 3 (journey contract version 2).

A **writer** (the bundled receiver, a BFF, a collector exporter) only
**inserts** `spans` and `events`. The dashboard **derives** `sessions` and
`rollups` from them, with its aggregator. `npm run conformance` checks a
writer against this document.

## Collection names

`spans`, `events`, `sessions`, `rollups` and `jobs`. When the dashboard runs
with `COLLECTION_PREFIX` (for example `journey_`, to share a database with
other applications), every name carries it: `journey_spans`,
`journey_events`, `journey_sessions`, `journey_rollups`, `journey_jobs`.
Writers use the same prefix. The rest of this document uses the bare names.

## Conventions

Field names are camelCase. Ids are lowercase hex. Times are BSON `Date`
(millisecond precision) **plus** a decimal string with the original
nanoseconds, because OTLP timestamps are 64-bit nanoseconds.

Attributes are stored as arrays of `{ key, value }` pairs, so keys with dots
(`http.request.method`) stay plain strings and never become nested paths.
`value` is the decoded OTLP `AnyValue`: string, number (integers outside the
safe range stay strings), boolean, array or object.

## Lean documents

A key that becomes a field is not stored again in `attributes` or
`resource`. Events store no `resource`: it is the same for the whole
session, and the fields keep what the dashboard uses from it. The trace view
puts the fields back as attributes.

Measured on the fictional session of `npm run seed`: an event takes about
0.8 KB (1.7 KB in version 2), an app span about 1.1 KB (1.9 KB).

## Shared fields

Present on `spans` and `events`. Values come from the record's attributes
first, then from its resource.

| Field | Type | From |
|---|---|---|
| `service` | string \| null | resource `service.name` |
| `serviceVersion` | string \| null | resource `service.version` |
| `environment` | string \| null | resource `deployment.environment.name` |
| `platform` | string \| null | resource `os.name`, else `os.type` |
| `deviceId` | string \| null | **only** what the writer authenticated (a device header it checks); never the payload. Null otherwise |
| `installationId` | string \| null | resource `app.installation.id` |
| `sessionId` | string \| null | `session.id` |
| `userId` | string \| null | `user.id`, **or what the writer authenticated** |
| `screen` | string \| null | `app.screen.name` |
| `flow` | string \| null | `journey.flow.name` |
| `flowInstanceId` | string \| null | `journey.flow.instance_id` |
| `actionName` | string \| null | `journey.action.name` |
| `actionInstanceId` | string \| null | `journey.action.instance_id` |
| `outcome` | `success` \| `failure` \| `cancelled` \| `completed` \| null | `journey.outcome` (other values: null) |
| `outcomeReason` | string \| null | `journey.outcome_reason` |
| `errorType` | string \| null | `error.type` |
| `source` | string \| null | `otel_flutter_bridge.source` (`dart` / `native`) |
| `scope` | `{ name, version }` | instrumentation scope |
| `receivedAt` | Date | the writer's clock when it stored the record; the aggregator reads by it |
| `expireAt` | Date | `receivedAt` + retention; TTL index |

The keys of this table are not repeated in `attributes`, nor the resource
keys in `resource`.

## `spans`

One document per span.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `{service}:{traceId}:{spanId}`; resends are ignored |
| `resource` | `{key, value}[]` | the OTLP resource without the keys above (`os.version`, `device.model.identifier`, ...) |
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
| `attributes` | `{key, value}[]` | without the keys stored as fields |
| `events` | `{ name, time, timeNs, attributes }[]` | span events |
| `links` | `{ traceId, spanId }[]` | |

Indexes: `{traceId: 1, start: 1}`, `{sessionId: 1, start: 1}`,
`{receivedAt: 1}`, TTL `{expireAt: 1}`.

## `events`

One document per OTLP log record (journey events). No `resource`.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `{service}:{log.record.uid}`; without a uid, a digest of resource, scope and record. Resends are ignored |
| `time` | Date | `time_unix_nano`, or `observed_time_unix_nano` when zero |
| `timeNs` | string | |
| `eventName` | string \| null | OTLP `event_name`, else attribute `event.name` |
| `severityNumber` | number | |
| `screenLabel`, `flowLabel`, `actionLabel` | string \| null | `journey.*.label` |
| `durationMs` | number \| null | `journey.duration_ms` |
| `traceId`, `spanId` | string \| null | null when the event happened outside a span |
| `attributes` | `{key, value}[]` | without the keys stored as fields, nor `event.name`, `log.record.uid`, the labels and `journey.duration_ms`. `session.previous_id` and `journey.flow.parent_instance_id` stay here |

Indexes: `{sessionId: 1, time: 1}`, `{traceId: 1}`, `{receivedAt: 1}`, TTL
`{expireAt: 1}`.

## Writing

- Insert a document only when its `_id` is new (`$setOnInsert` with
  `upsert`, or an unordered insert that ignores duplicate keys): OTLP
  clients resend after a timeout.
- Set `receivedAt` from the writer's clock at insert time. The aggregator
  waits `AGGREGATE_LAG_SECONDS` (30) before reading a record, so slow inserts
  and clock differences between writer and dashboard must stay below that.
- Never write `sessions`, `rollups` or `jobs`.

## Derived collections

The dashboard's aggregator fills these (modes `all` and `query`, unless
`AGGREGATOR=off`). Every 15 seconds it reads what was received since its
last run, in chunks of `receivedAt`, and updates the documents those
records touch.

- **No double counts.** Before a chunk it records the chunk's end in
  `jobs`; each document it updates holds `upTo`, the end of the last chunk
  applied to it, and is only updated while `upTo` is older. A chunk redone
  after a crash changes nothing that was already applied.
- **One instance at a time.** The job is a lease in `jobs`; another
  instance takes over when it expires.
- **First run.** It rebuilds `sessions` and `rollups` from every record
  still stored.

### `sessions`

One summary per `session.id`.

| Field | Type | Rule |
|---|---|---|
| `_id` | string | `session.id` |
| `deviceId` | string \| null | last non-null `deviceId` seen |
| `installationId` | string \| null | last non-null `installationId` seen |
| `previousSessionId` | string \| null | `session.previous_id` of the session's `session.start` event, when it differs from `_id` |
| `userIds` | string[] | non-null `userId` values |
| `services`, `versions`, `platforms`, `environments` | string[] | |
| `firstSeen` | Date | earliest event `time` / span `start` |
| `lastSeen` | Date | latest event `time` / span `end` |
| `eventCount` | number | events |
| `spanCount` | number | spans with a `sessionId` |
| `errorCount` | number | events with `outcome: failure`, plus **root** spans with `statusCode: 2` and no `actionInstanceId` (one per failed operation) |
| `flows` | string[] | codes of the flows started |
| `failures` | `{ kind, code, reason, errorType }[]` | each failed flow run (`kind: flow`, from `journey.flow.end`) and action (`kind: action`): what failed and why. Drill-down from the overview |
| `upTo` | Date | aggregation guard |
| `expireAt` | Date | latest `expireAt` of its records; TTL |

Indexes: `{lastSeen: -1}`, `{deviceId: 1, lastSeen: -1}`,
`{installationId: 1, lastSeen: -1}`, `{userIds: 1, lastSeen: -1}`,
`{'failures.code': 1, lastSeen: -1}`, `{flows: 1, lastSeen: -1}`, TTL
`{expireAt: 1}`.

Spans and events without `sessionId` (for example backend spans of the same
trace) are shown in traces, but do not touch `sessions`.

### `rollups`

Counters per hour, app, version, platform and environment, so the overview
reads a few thousand small documents instead of millions of events. They
cover 100% of what was received and last `ROLLUP_RETENTION_DAYS` (400),
longer than the records themselves.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | JSON of `[hour, service, version, platform, environment, kind, code]` |
| `hour` | Date | start of the hour (UTC) |
| `service`, `version`, `platform`, `environment` | string \| null | of the records |
| `kind` | `session` \| `flow` \| `action` | |
| `code` | string | flow or action code; empty for `session` |
| `label` | string | last `journey.*.label` seen |
| `n` | number | `session`: sessions seen for the first time. `flow`: runs started (`journey.flow.start`). `action`: `journey.action` events |
| `success`, `failure`, `cancelled`, `completed` | number | results. **A flow run counts in the hour it started** (`time` of `journey.flow.end` minus its `journey.duration_ms`), so `n` minus the results is what has no conclusion |
| `failed` | number | `session`: sessions whose first failure happened in this hour |
| `reasons` | `{ [outcome]: { [reason]: number } }` | `journey.outcome_reason` per result |
| `errors` | `{ [error.type]: number }` | failures without a reason |
| `dur` | `{ [bucket]: number }` | histogram of `journey.duration_ms` (flow runs, measured actions); bucket `i` holds durations up to the `i`-th bound, the last one the rest |
| `upTo` | Date | aggregation guard |
| `expireAt` | Date | `hour` + rollup retention; TTL |

Counters are absent when zero. Reason and error codes are field names, so
`.`, `$` and `%` are percent-escaped (`System%2ETimeoutException`).

Duration bounds, in milliseconds: 50, 100, 200, 300, 500, 750, 1000, 1500,
2000, 3000, 5000, 7500, 10000, 15000, 30000, 60000, 120000, 300000, 600000.

Indexes: `{kind: 1, hour: 1}`, TTL `{expireAt: 1}`.

### `jobs`

`{ _id: "aggregate", done, pending, owner, leaseUntil }`: everything received
up to `done` is aggregated.

## Reads also filter expiry

TTL deletion runs about once a minute, so every query also filters
`expireAt > now`.

## Changes from version 2

- Writers only insert `spans` and `events`. `sessions` is derived by the
  dashboard, which rebuilds it on its first run.
- Lean documents: keys stored as fields are not repeated in `attributes`
  and `resource`; events have no `resource`.
- New: `receivedAt` indexes (the aggregator reads by them); `sessions.flows`,
  `sessions.failures` and `sessions.upTo`; the `rollups` and `jobs`
  collections.
- Removed indexes nothing queried: `events` by device, installation, user
  and outcome; `spans` by status.
