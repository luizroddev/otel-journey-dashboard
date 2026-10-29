# Architecture, in diagrams

How the dashboard receives, stores, derives and shows journeys. The diagrams
are Mermaid (GitHub draws them); the text stays readable without rendering.

For the app side (what the library records and sends), see
[architecture.md](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/architecture.md)
in `otel_flutter_bridge`. For adopting both in an existing system, see the
[adoption guide](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/adoption-guide.pt-BR.md)
(Portuguese).

1. [Components and modes](#1-components-and-modes)
2. [Where it runs](#2-where-it-runs)
3. [Receiving a request](#3-receiving-a-request)
4. [The aggregator](#4-the-aggregator)
5. [Collections](#5-collections)
6. [From a page to the data](#6-from-a-page-to-the-data)
7. [How a journey is built](#7-how-a-journey-is-built)
8. [How long until it shows, how long it stays](#8-how-long-until-it-shows-how-long-it-stays)

## 1. Components and modes

One Node process with three parts, switched on by `MODE`. Writers only
insert `spans` and `events`. The aggregator derives everything else
([storage-schema.md](storage-schema.md)).

```mermaid
flowchart LR
  APP["App or backend<br/>OTLP/HTTP"] -->|"/v1/traces · /v1/logs"| RCV
  subgraph proc["otel-journey-dashboard (Node)"]
    direction LR
    RCV["Receiver<br/>server/src/http/ingest.ts<br/>modes all, ingest"]
    AGG["Aggregator<br/>server/src/aggregate/<br/>modes all, query"]
    API["Query API + UI<br/>server/src/http/api.ts, web/<br/>modes all, query"]
  end
  RCV -->|"insert only"| RAW[("spans<br/>events")]
  RAW -->|"read by receivedAt"| AGG
  AGG -->|"upsert, guarded"| DER[("sessions<br/>rollups<br/>jobs")]
  RAW --> API
  DER --> API
  API --> UI["Browser<br/>Overview · Sessions · Journey · Trace"]
  EXT["Your backend<br/>(option A)"] -.->|"insert only"| RAW
```

| `MODE` | Receiver | Aggregator | API and UI |
|---|---|---|---|
| `all` | yes | yes | yes |
| `ingest` | yes | no | no |
| `query` | no | yes (`AGGREGATOR=off` to skip) | yes |

## 2. Where it runs

**Local or personal projects**: one process does everything.

```mermaid
flowchart LR
  A1["App"] -->|"OTLP"| D1["Dashboard<br/>MODE=all"] --> M1[("MongoDB")]
```

**Option A: your backend writes MongoDB.** It already authenticates the
device and the user, so it stamps them, applies its allowlist and only
inserts. The dashboard aggregates and serves, behind your SSO.

```mermaid
flowchart LR
  A2["App"] -->|"OTLP"| B2["Your backend<br/>authenticates · stamps the device<br/>allowlist · inserts"]
  B2 --> M2[("MongoDB<br/>COLLECTION_PREFIX")]
  M2 --> D2["Dashboard<br/>MODE=query"]
  P2["SSO proxy<br/>BASE_PATH"] --> D2
```

**Option B: your backend forwards.** When it cannot write MongoDB yet, it
authenticates and forwards the body untouched, with trusted headers, to a
receiver only it can reach.

```mermaid
flowchart LR
  A3["App"] -->|"OTLP"| B3["Your backend<br/>authenticates"]
  B3 -->|"same body +<br/>trusted headers"| I3["Dashboard<br/>MODE=ingest<br/>private network only"]
  I3 --> M3[("MongoDB")]
  M3 --> Q3["Dashboard<br/>MODE=query"]
  P3["SSO proxy"] --> Q3
```

Details: [backend-integration.md](backend-integration.md).

## 3. Receiving a request

The same rules apply to any writer; the conformance check
(`npm run conformance`) verifies them on what was stored.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (app or backend)
  participant R as Receiver
  participant M as MongoDB

  C->>R: POST /v1/logs (protobuf or JSON, optional gzip)
  alt INGEST_TOKEN set and missing
    R-->>C: 401
  end
  R->>R: content type and encoding, else 415
  R->>R: size limit before and after gunzip, else 413
  R->>R: decode OTLP, else 400
  R->>R: records per request, else 413
  R->>R: identity from trusted headers (device always, user only where the record has one)
  R->>R: map to documents (lowercase hex ids, Date + nanosecond string, lean attributes, receivedAt)
  R->>M: insertMany(unordered), duplicate _id ignored
  alt storage unavailable
    R-->>C: 503, the client may resend
  else stored
    R-->>C: 200 with an OTLP export response
  end
```

## 4. The aggregator

Every 15 seconds, one instance (the lease holder) reads what arrived since
its last run, in chunks of `receivedAt`, and updates the session summaries
and the hourly counters those records touch. A chunk redone after a crash
changes nothing that was already applied.

```mermaid
flowchart TD
  T(["every AGGREGATE_EVERY_SECONDS"]) --> L{"lease in jobs<br/>free, expired or ours?"}
  L -->|"no"| STOP(["another instance aggregates"])
  L -->|"yes"| F{"first run?"}
  F -->|"yes"| RB["rebuild: clear sessions and rollups,<br/>aggregate every record still stored"]
  F -->|"no"| W["window: (done, now − AGGREGATE_LAG_SECONDS]"]
  RB --> W
  W --> C["next chunk (done, to]<br/>write pending = to first"]
  C --> READ["read spans and events<br/>with receivedAt in the chunk"]
  READ --> S["sessions: one upsert per session<br/>only where upTo &lt; to"]
  READ --> R["rollups: one upsert per hour, app, version,<br/>platform, kind and code<br/>only where upTo &lt; to"]
  S --> D["done = to, pending cleared"]
  R --> D
  D --> SIZE["next chunk length: ×2 under 10,000 records,<br/>÷2 over 50,000"]
  SIZE --> MORE{"more to read?"}
  MORE -->|"yes"| C
  MORE -->|"no"| END(["wait for the next run"])
```

What each document holds:

```mermaid
flowchart LR
  EV["events and spans<br/>of one session"] --> SES["sessions<br/>firstSeen · lastSeen · counts<br/>device · installation · users<br/>flows started · failures (kind, code, reason)"]
  EV --> ROL["rollups (per hour)<br/>session: new sessions, sessions with a first failure<br/>flow: runs started, results, reasons, durations<br/>action: events, results, reasons, errors, durations"]
  ROL --> OV["Overview<br/>periods, comparisons, what changed"]
  SES --> LIST["Sessions list<br/>filters and drill-down"]
```

A flow run is counted in the hour it **started** (end time minus its
duration), so runs started minus results is what has no conclusion.

## 5. Collections

```mermaid
erDiagram
  SESSIONS ||--o{ EVENTS : "sessionId"
  SESSIONS ||--o{ SPANS : "sessionId"
  EVENTS }o--o| SPANS : "traceId, spanId"
  SPANS }o--o| SPANS : "parentSpanId"
  ROLLUPS }o..o{ EVENTS : "counted from"
  JOBS ||..|| ROLLUPS : "aggregation progress"

  EVENTS {
    string _id "service:log.record.uid"
    date time
    string eventName
    string sessionId
    string userId
    string deviceId
    string screen
    string flow
    string flowInstanceId
    string actionName
    string outcome
    string outcomeReason
    string traceId
    date receivedAt
  }
  SPANS {
    string _id "service:traceId:spanId"
    string traceId
    string spanId
    string parentSpanId
    string name
    date start
    number durationMs
    number statusCode
    string sessionId
    date receivedAt
  }
  SESSIONS {
    string _id "session.id"
    string deviceId
    string installationId
    array userIds
    date firstSeen
    date lastSeen
    array flows
    array failures
    date upTo
  }
  ROLLUPS {
    string _id "hour, app, version, platform, env, kind, code"
    date hour
    string kind "session, flow or action"
    string code
    number n
    object reasons
    object dur
    date upTo
  }
  JOBS {
    string _id "aggregate"
    date done
    date pending
    string owner
    date leaseUntil
  }
```

| Collection | Written by | Read by | TTL |
|---|---|---|---|
| `spans`, `events` | receiver or your backend (insert only) | aggregator, API | `RETENTION_DAYS` |
| `sessions` | aggregator | API (lists, filters) | latest record's `expireAt` |
| `rollups` | aggregator | API (overview) | `ROLLUP_RETENTION_DAYS` |
| `jobs` | aggregator | aggregator | none |

With `COLLECTION_PREFIX=journey_`, every name carries the prefix.

## 6. From a page to the data

```mermaid
flowchart LR
  subgraph ui["UI (BASE_PATH)"]
    OV["/ Overview"]
    SL["/sessions"]
    SJ["/sessions/:id"]
    TR["/traces/:traceId"]
  end
  subgraph api["/api"]
    A1["overview"]
    A2["sessions"]
    A6["facets"]
    A3["sessions/:id/journey"]
    A4["traces/:traceId"]
    A5["config · status"]
  end
  OV --> A1 --> RO[("rollups")]
  SL --> A2 --> SE[("sessions")]
  SL --> A6 --> RO
  SJ --> A3
  A3 --> SE
  A3 --> EV[("events")]
  A3 --> SP[("spans")]
  TR --> A4 --> SP
  OV -. "drill-down with filters" .-> SL
  SL --> SJ
  SJ -->|"a step's trace"| TR
  SJ -.->|"TRACE_LINK_TEMPLATE"| LOG["Your log tool"]
  TR -.-> LOG
```

Endpoints: [query-api.md](query-api.md).

## 7. How a journey is built

`GET /api/sessions/:id/journey` turns the session's events into steps and
flow runs (`server/src/query/journey.ts`).

```mermaid
flowchart TD
  E["events of the session<br/>(up to MAX_JOURNEY_EVENTS)"] --> K["one step per event, by event name<br/>session.start → session<br/>journey.screen.view → screen<br/>journey.action → action (measured when it has a duration and a trace)<br/>journey.flow.start / end → flow start / end<br/>device.app.lifecycle → lifecycle<br/>anything else → event"]
  K --> O["order by time, ties: session first, flow start before<br/>what happens in it, flow end after"]
  O --> FR["flow runs by journey.flow.instance_id<br/>status: the end's outcome, or open (no conclusion)<br/>attempt: 1, 2, ... per flow code in the session"]
  RS["root spans of the session"] --> OT["other traces: roots with no step"]
  FR --> V["JourneyView: steps, flows, otherTraces"]
  OT --> V
  V --> RAIL["Journey rail: screens are stations, actions are stops,<br/>each flow run is a colored stretch"]
```

## 8. How long until it shows, how long it stays

```mermaid
flowchart LR
  H["Something happens<br/>in the app"] -->|"up to 2 s batch,<br/>or leaving the foreground"| S["Sent"]
  S -->|"network"| I["Inserted<br/>receivedAt"]
  I -->|"30 s lag + up to 15 s"| A["Aggregated"]
  A --> V["In the sessions list<br/>and the overview<br/>(about 1 minute)"]
  I --> J["Trace page, and new steps of a session<br/>already listed: read records directly"]
  I -->|"RETENTION_DAYS (30)"| X["Records and sessions expire"]
  A -->|"ROLLUP_RETENTION_DAYS (400)"| Y["Hourly counters expire"]
```

The overview reads the hourly counters, so trends outlive the records
themselves.
