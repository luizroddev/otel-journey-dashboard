# Plugging the dashboard into an existing backend

Locally, one process does everything: it receives OTLP, writes MongoDB and
serves the UI. In many setups the telemetry should instead reach a backend
you already run (an API gateway, a BFF), which already knows who the device
and the user are. The dashboard is split into three contracts so that swap
is direct:

| Contract | Document | Who implements it |
|---|---|---|
| What the app sends | [journey.md](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/specs/journey.md) in `otel_flutter_bridge` | The app |
| How data is stored in MongoDB | [storage-schema.md](storage-schema.md) | Whoever writes `spans` and `events`: the bundled receiver or your backend. The dashboard derives the rest |
| How the dashboard reads | [query-api.md](query-api.md) | This repository, in `MODE=query` |

```text
Local:          app ──OTLP──► dashboard (MODE=all) ──► MongoDB

Your backend:   app ──OTLP──► backend (authenticates, inserts) ──► MongoDB ◄── dashboard (MODE=query: aggregates, serves) ◄── your SSO proxy
```

Your backend only inserts. Session summaries and the hourly counters of the
overview are computed by the dashboard, so the backend keeps no state and
does no read-modify-write per request.

## Option A: your backend writes MongoDB

1. **Receive.** Expose `POST /v1/traces` and `POST /v1/logs` (any prefix;
   the app only changes its `endpoint`). Bodies are OTLP protobuf
   (`application/x-protobuf`); accept `Content-Encoding: gzip` too. Answer
   200 with an empty body on success and 503 when you cannot store, so the
   sender retries.
2. **Decode.** Generate classes from the official `.proto` files (the ones in
   `server/proto`, version 1.5.0) with the protobuf tooling of your
   language, and parse `ExportTraceServiceRequest` /
   `ExportLogsServiceRequest`.
3. **Identity.** Set `deviceId` from the device your backend authenticated
   (a header it already checks); the app does not send `device.id`. Replace
   `user.id` with the authenticated user when you know it, or store a keyed
   hash (HMAC with a server secret) instead of a document number: a plain
   hash of a small number space can be reversed by hashing every value.
4. **Allowlist and scrubbing.** If your backend filters attributes, event
   names or span names, accept everything in the "Receivers" section of
   [journey.md](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/specs/journey.md#receivers).
   Never scrub the values of ids (`session.id`, `log.record.uid`,
   `journey.*.instance_id`, `app.installation.id`, trace and span ids): they
   are random hex, and about 1 in 20 contains a run of 11 or more digits, so
   a rule for document numbers would corrupt them and break the journey.
5. **Map and insert.** Follow [storage-schema.md](storage-schema.md) field
   by field. The executable reference is `server/src/ingest/mapping.ts` and
   `writeSpans` / `writeEvents` in `server/src/store/mongo.ts`. What
   usually goes wrong:
   - ids must be lowercase hex (protobuf carries bytes);
   - keep time both as a BSON `Date` and as a nanosecond string;
   - attributes are a `{ key, value }` list, never an object with dotted keys,
     and leave out the keys stored as fields (lean documents);
   - `events._id` is `{service}:{log.record.uid}`;
   - insert only when `_id` is new: an unordered insert that ignores
     duplicate key errors is enough;
   - `receivedAt` is your clock at insert time;
   - never write `sessions`, `rollups` or `jobs`;
   - when the dashboard runs with `COLLECTION_PREFIX` (a database shared
     with other applications), every name carries it: insert into
     `journey_spans` and `journey_events`, not `spans` and `events`.
6. **Limits.** Apply body size, records per request and per-device quotas
   according to your own policy.
7. **Validate.** Run the conformance check against your backend:

   ```bash
   npm run conformance -- --endpoint https://telemetry.example.com \
     --mongo "mongodb://..." --db otel_journey [--prefix journey_] \
     --header "Authorization: Bearer <test token>" \
     --expect-device <device your backend will authenticate> --expect-user <user>
   ```

   It sends one fictional session twice (resends must not duplicate) and
   checks 29 rules on what was stored in `spans` and `events` (with
   `--prefix`, or `COLLECTION_PREFIX` set, in the prefixed collections). Without
   `--expect-device`, `deviceId` must stay null.
8. **Indexes.** Create the indexes of `spans` and `events` once, including
   `{receivedAt: 1}` on both (the bundled receiver does it when it starts in
   `all` or `ingest`).
9. **Run the dashboard.** `MODE=query` against the same MongoDB, behind
   your SSO proxy:

   ```bash
   MODE=query MONGO_URL="mongodb://dashboard@..." MONGO_DB=otel_journey PORT=8686 npm start
   ```

   Inside a portal you already have: `BASE_PATH=/journey/` when the proxy
   mounts it on a sub path (it forwards the path without removing the
   prefix), `COLLECTION_PREFIX=journey_` in a shared database, and
   `TRACE_LINK_TEMPLATE` to open each trace in your log tool (see the
   README, "Inside an existing environment").

   Its user reads `spans` and `events` and writes `sessions`, `rollups` and
   `jobs` (it creates their indexes). It never writes `spans` or `events`.
   Several instances can run: one aggregates at a time. Extra instances
   that should only serve can run with `AGGREGATOR=off` and a read-only
   user.

## Option B: your backend forwards to the bundled receiver

When writing MongoDB from your backend is not possible yet:

1. Run this repository with `MODE=ingest`, reachable **only** from your
   backend's network.
2. Your backend authenticates, forwards the OTLP body untouched and adds two
   headers with the validated identity.
3. Tell the receiver to trust them:

   ```bash
   MODE=ingest TRUSTED_DEVICE_HEADER=X-Validated-Device TRUSTED_USER_HEADER=X-Validated-User npm start
   ```

   The device header is the only source of `deviceId`. The user header
   replaces `user.id` on the records that carry one: events from before the
   login keep none, even when the app sends them after logging in, and a
   request without the header keeps the payload's value.
4. Another instance in `MODE=query` aggregates and serves the UI.

## Searching by several devices

A person can have several devices, installations and user ids. The device,
installation and user filters take up to 50 values, separated by commas,
spaces or lines (`/sessions?deviceId=a,b,c`), and show the sessions of any
of them.

## Searching by another identifier

The dashboard filters by device, installation (`app.installation.id`),
user and session. When an
investigation starts from some other identifier your organization uses,
resolve it to a device or user in the service that already owns that lookup
and pass the result as a filter (`/?deviceId=...`). That identifier should
not go into telemetry.

## What stays with your environment

Authentication and authorization of who queries, tenant separation, access
auditing, retention (`RETENTION_DAYS` here; in your backend, the `expireAt`
it writes; `ROLLUP_RETENTION_DAYS` for the hourly counters) and quotas. The
defaults of this repository (30 days of records, 400 days of counters,
1 MiB, 1000 records, 31-day window, pages of 200) are examples, not a
policy. Because the overview reads the counters, records can be kept for
less time than the trends you want to see.
