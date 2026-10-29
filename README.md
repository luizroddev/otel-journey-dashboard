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
npm install && npm run seed      # optional: fictional sessions
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

- **Sessions**: filter by period, device, installation, user, session, app,
  version, platform, or only sessions with failures. A session that
  continues an expired one links back to it.
- **Journey**: the session as a line. Screens are stations, actions are
  stops, each flow run is a colored stretch with its result. Failed steps
  are red; a flow that started and never ended shows "no conclusion", not
  "abandoned".
- **Step detail**: result, reason and duration, screen, flow and attempt, user,
  origin (Flutter or native), the app's own attributes, and the waterfall of
  the step's trace (app spans, HTTP, backend spans) with every attribute.
- **Trace**: any trace by id, with missing parents and truncation flagged.

## Modes

| `MODE` | Runs | Use |
|---|---|---|
| `all` (default) | OTLP receiver + UI + query API | Local, personal projects |
| `ingest` | OTLP receiver only | Receiver behind a proxy |
| `query` | UI + query API only, read-only | A MongoDB filled by something else (a BFF) |

Plugging it into a backend you already run (one that receives the telemetry
and writes MongoDB): [docs/backend-integration.md](docs/backend-integration.md).

## Contracts

| | |
|---|---|
| [docs/storage-schema.md](docs/storage-schema.md) | MongoDB collections, fields and indexes. Whatever writes this can be read by `query` mode |
| [docs/query-api.md](docs/query-api.md) | The JSON API the UI reads |
| `npm run conformance` | Sends a fictional session to a receiver and checks what it stored (31 checks) |

## Configuration

| Variable | Default | |
|---|---|---|
| `MODE` | `all` | `all`, `ingest`, `query` |
| `MONGO_URL` | `mongodb://localhost:27017` | |
| `MONGO_DB` | `otel_journey` | |
| `OTLP_PORT` | `4318` | OTLP receiver |
| `PORT` | `8686` | UI and API |
| `RETENTION_DAYS` | `30` | TTL of stored records |
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
