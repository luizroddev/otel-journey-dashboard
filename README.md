# otel-journey-dashboard

A dashboard for OpenTelemetry **journeys**: find a device, a user or a
session, read what happened step by step (screens, flows, actions and how
each ended) and open the span tree behind any step.

It receives plain OTLP/HTTP (traces and logs), stores it in MongoDB and
serves the UI. It reads the journey contract of
[otel_flutter_bridge](https://github.com/luizroddev/otel_flutter_bridge)
([journey.md](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/specs/journey.md)),
and any OTLP source that follows it.

## Run it

Requirements: Docker, or Node 20+ and a MongoDB.

```bash
docker compose up -d --build     # MongoDB + dashboard
npm install && npm run seed      # optional: two days of fictional sessions, with a made-up incident
```

- Dashboard: http://localhost:8686
- OTLP receiver: http://localhost:4318 (`/v1/traces`, `/v1/logs`)

Point the app there:

```dart
OtelBridgeConfig(serviceName: 'my-app', endpoint: Uri.parse('http://<host>:4318'));
```

Without Docker for the app itself:

```bash
docker compose up -d mongo
npm install
npm run build && npm start        # or: npm run dev (Vite on :5173 + API)
```

## What you see

- **Overview**: sessions, sessions with failures, failed flows and flows
  with no conclusion, against the previous period or the same hours a week
  earlier. "What changed" points at the flow, version, platform and reason
  behind a difference, and at slower actions. Each flow shows how its runs
  ended, its p95 and its failure rate over time, by version and by reason.
  Every number opens the sessions behind it.
- **Sessions**: filter by period, device, installation, user, session, app,
  version, platform, or only sessions with failures. Device, installation
  and user take several values at once (a person with several devices). A
  session that continues an expired one links back to it.
- **Journey**: the session as a line. Screens are stations, actions are
  stops, each flow run is a colored stretch with its result. Failed steps
  are red; a flow that started and never ended shows "no conclusion", not
  "abandoned".
- **Step detail**: result, reason and duration, screen, flow and attempt, user,
  origin (Flutter or native), the app's own attributes, and the waterfall of
  the step's trace (app spans, HTTP, backend spans) with every attribute.
- **Trace**: any trace by id, with missing parents and truncation flagged,
  and a link to the same trace in your log tool when configured.

## Modes

| `MODE` | Runs | Use |
|---|---|---|
| `all` (default) | OTLP receiver + aggregator + UI + query API | Local, personal projects |
| `ingest` | OTLP receiver only | Receiver behind a proxy |
| `query` | aggregator + UI + query API | A MongoDB where something else (a BFF) inserts spans and events |

The receiver only inserts spans and events. The aggregator derives the
session summaries and hourly counters from them, so whatever writes the
records stays simple. Sessions show up within about a minute of arriving.

Plugging it into a backend you already run (one that receives the telemetry
and writes MongoDB): [docs/backend-integration.md](docs/backend-integration.md).

## Inside an existing environment

- **A shared database.** `COLLECTION_PREFIX=journey_` puts every collection
  under that prefix (`journey_spans`, `journey_events`, `journey_sessions`,
  `journey_rollups`, `journey_jobs`). A backend that writes spans and events
  itself uses the same names.
- **A sub path behind a reverse proxy.** `BASE_PATH=/journey/` serves the
  UI, its assets and `/api` under that path; `/` redirects there. The proxy
  forwards the path as it is, without removing the prefix. The base is read
  at runtime, so one build (or image) serves any path. `/health` stays at
  the root, for probes; the OTLP port does not change.
- **The log tool you already use.** With
  `TRACE_LINK_TEMPLATE=https://logs.example.com/app/discover#/?query=trace.id:{traceId}`,
  the trace page and every journey step that has a trace link to it, in a
  new tab (`{traceId}` is URL-encoded). `TRACE_LINK_LABEL` names the link.
- **One person, several devices.** The device, installation and user
  filters take up to 50 values, separated by commas, spaces or lines: paste
  the list and see all their sessions at once.

## Contracts

| | |
|---|---|
| [docs/storage-schema.md](docs/storage-schema.md) | MongoDB collections, fields and indexes: what a writer inserts, what the dashboard derives |
| [docs/query-api.md](docs/query-api.md) | The JSON API the UI reads |
| `npm run conformance` | Sends a fictional session to a receiver and checks what it stored (29 checks) |

## Configuration

| Variable | Default | |
|---|---|---|
| `MODE` | `all` | `all`, `ingest`, `query` |
| `MONGO_URL` | `mongodb://localhost:27017` | |
| `MONGO_DB` | `otel_journey` | |
| `COLLECTION_PREFIX` | | before every collection name (`journey_spans`), to share a database |
| `BASE_PATH` | `/` | sub path of the UI and `/api`, behind a reverse proxy (`/journey/`) |
| `TRACE_LINK_TEMPLATE` | | URL of a trace in your log tool, with `{traceId}`; adds a link to traces and journey steps |
| `TRACE_LINK_LABEL` | `Abrir no log` | text of that link |
| `OTLP_PORT` | `4318` | OTLP receiver |
| `PORT` | `8686` | UI and API |
| `RETENTION_DAYS` | `30` | TTL of stored records and sessions |
| `ROLLUP_RETENTION_DAYS` | `400` | TTL of the hourly counters |
| `AGGREGATOR` | `on` | `off`: this instance only serves (modes `all`, `query`) |
| `AGGREGATE_EVERY_SECONDS` / `AGGREGATE_LAG_SECONDS` | `15` / `30` | how often the aggregator runs, and how old a record must be before it reads it |
| `OVERVIEW_MIN_VOLUME` | `200` | smallest group the overview compares (flow runs, measured actions) |
| `MAX_BODY_BYTES` | `1048576` | per OTLP request (before gunzip) |
| `MAX_RECORDS_PER_REQUEST` | `1000` | spans or log records |
| `MAX_WINDOW_DAYS` | `31` | longest query period |
| `MAX_PAGE_SIZE` | `200` | sessions per page |
| `MAX_JOURNEY_EVENTS` / `MAX_TRACE_SPANS` | `5000` / `2000` | per view; the UI says when it hit them |
| `INGEST_TOKEN` | | require `Authorization: Bearer` on ingestion |
| `API_TOKEN` | | require it on `/api` (UI: `localStorage.apiToken`) |
| `TRUSTED_DEVICE_HEADER` / `TRUSTED_USER_HEADER` | | headers from a trusted proxy: the device header is the only source of `deviceId`; the user header replaces `user.id` |

The defaults are examples for local use, not a production policy.

## Development

```bash
docker compose up -d mongo
npm run dev                                         # API :8686 + Vite :5173
MONGO_URL=mongodb://localhost:27017 npm test        # unit + MongoDB end to end
npm run typecheck
```

`server/` is the receiver and API (Node, Hono, official OTLP `.proto`
files), `web/` the UI (React, Vite), `scripts/` seed and conformance.

## Limits

- OTLP/HTTP only (protobuf or JSON, optionally gzip). No gRPC, no metrics.
- Deduplication covers identical resends, not exactly-once delivery.
- No built-in user accounts: use `API_TOKEN` locally, an SSO proxy in a
  company.

## Data

This repository only contains fictional data (the `demo-shop` sessions of
`npm run seed`). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0.
