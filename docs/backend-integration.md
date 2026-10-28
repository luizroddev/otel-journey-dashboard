# Plugging the dashboard into an existing backend

Locally, one process does everything: it receives OTLP, writes MongoDB and
serves the UI. In many setups the telemetry should instead reach a backend
you already run (an API gateway, a BFF), which already knows who the device
and the user are. The dashboard is split into three contracts so that swap
is direct:

| Contract | Document | Who implements it |
|---|---|---|
| What the app sends | [journey.md](https://github.com/luizroddev/otel_flutter_bridge/blob/main/docs/specs/journey.md) in `otel_flutter_bridge` | The app |
| How data is stored in MongoDB | [storage-schema.md](storage-schema.md) | Whoever writes: the bundled receiver or your backend |
| How the dashboard reads | [query-api.md](query-api.md) | This repository, in `MODE=query` |

```text
Local:          app ──OTLP──► dashboard (MODE=all) ──► MongoDB

Your backend:   app ──OTLP──► backend (authenticates, writes) ──► MongoDB ◄── dashboard (MODE=query) ◄── your SSO proxy
```

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
5. **Map and write.** Follow [storage-schema.md](storage-schema.md) field by
   field. The executable reference is `server/src/ingest/mapping.ts` and
   `server/src/store/mongo.ts`. What usually goes wrong:
   - ids must be lowercase hex (protobuf carries bytes);
   - keep time both as a BSON `Date` and as a nanosecond string;
   - attributes are a `{ key, value }` list, never an object with dotted keys;
   - `events._id` is `{service}:{log.record.uid}`;
   - insert only when `_id` is new (`$setOnInsert` with `upsert`) and update
     `sessions` only with what was actually inserted;
   - `errorCount`: one per failed operation (a `failure` event, or a root
     span with error and no `actionInstanceId`).
6. **Limits.** Apply body size, records per request and per-device quotas
   according to your own policy.
7. **Validate.** Run the conformance check against your backend:

   ```bash
   npm run conformance -- --endpoint https://telemetry.example.com \
     --mongo "mongodb://..." --db otel_journey \
     --header "Authorization: Bearer <test token>" \
     --expect-device <device your backend will authenticate> --expect-user <user>
   ```

   It sends one fictional session twice (resends must not duplicate) and
   checks 31 rules on what was stored. Without `--expect-device`, `deviceId`
   must stay null.
8. **Read.** Run this dashboard with `MODE=query` against the same MongoDB
   (a read-only user is enough), behind your SSO proxy:

   ```bash
   MODE=query MONGO_URL="mongodb://reader@..." MONGO_DB=otel_journey PORT=8686 npm start
   ```

   In `query` mode the dashboard writes nothing and creates no indexes.
   Create the indexes of the schema once (the bundled receiver does it when
   it starts in `all` or `ingest`).

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

   The device header is the only source of `deviceId`; the user header
   replaces `user.id` from the payload.
4. Another instance in `MODE=query` serves the UI.

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
it writes) and quotas. The defaults of this repository (30 days, 1 MiB,
1000 records, 31-day window, pages of 200) are examples, not a policy.
