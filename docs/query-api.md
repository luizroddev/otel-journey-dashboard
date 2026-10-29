# Query API

JSON over HTTP, read by the dashboard UI. Served under `/api` in `all` and
`query` modes; with `BASE_PATH=/journey/`, under `/journey/api`. It is the
dashboard's own read model, not OTLP JSON.

When `API_TOKEN` is set, every request needs `Authorization: Bearer <token>`
(the UI reads the token from `localStorage.apiToken`). In a company
environment, put the dashboard behind the existing SSO proxy instead.

Errors: `{ "error": "<message>" }` with 400 (invalid parameters), 401, 404.

## `GET /api/sessions`

| Parameter | Default | |
|---|---|---|
| `from`, `to` | last 24 h | ISO 8601. Window clamped to `MAX_WINDOW_DAYS` (31) |
| `deviceId`, `installationId`, `userId` | | one or several values, comma separated: sessions of any of them. Spaces around values and repeats are ignored; values cannot contain commas. At most 50 per parameter (400 beyond) |
| `sessionId` | | exact match |
| `service`, `version`, `platform`, `environment` | | exact match |
| `onlyErrors` | `false` | `true`: `errorCount > 0` |
| `flow` | | sessions that started this flow |
| `failedFlow` / `failedAction` | | sessions where a run of this flow, or this action, failed |
| `reason`, `errorType` | | with `failedFlow` / `failedAction`: only failures with this `journey.outcome_reason` / `error.type` |
| `limit` | 50 | at most `MAX_PAGE_SIZE` (200) |
| `before` | | cursor: the previous page's `nextBefore` |

Sessions whose `lastSeen` falls in the window, newest first. Sessions are
derived by the aggregator: what was received in the last minute may not be
there yet (see `/api/status`).

```json
{
  "items": [ { "_id": "…", "deviceId": null, "installationId": "…", "previousSessionId": null,
               "userIds": [], "firstSeen": "…", "lastSeen": "…",
               "eventCount": 15, "spanCount": 6, "errorCount": 1, "services": [], "versions": [],
               "platforms": [], "environments": [], "flows": ["login"],
               "failures": [ { "kind": "action", "code": "confirmLogin", "reason": "invalidPassword", "errorType": "401" } ] } ],
  "nextBefore": "2026-10-28T12:00:00.000Z",
  "period": { "from": "…", "to": "…", "clamped": false }
}
```

## `GET /api/sessions/:id`

The session summary, or 404.

## `GET /api/sessions/:id/journey`

```json
{
  "session": { },
  "steps": [ {
    "id": "…", "time": "…", "timeNs": "…",
    "kind": "session | screen | action | flowStart | flowEnd | event",
    "eventName": "journey.action", "code": "confirmLogin", "label": "Confirmou o login",
    "screen": "login", "flow": "login", "flowInstanceId": "…", "actionInstanceId": "…",
    "measured": true, "outcome": "failure", "outcomeReason": "invalidPassword",
    "durationMs": 675, "errorType": "401",
    "traceId": "…", "spanId": "…", "source": "dart", "userId": null, "previousSessionId": null,
    "extra": [ { "key": "app.login.attempt", "value": 1 } ]
  } ],
  "flows": [ {
    "instanceId": "…", "code": "login", "label": "Login", "start": "…", "end": "…",
    "status": "success | failure | cancelled | completed | open", "reason": null,
    "durationMs": 5400, "attempt": 1, "steps": 6, "failures": 1
  } ],
  "otherTraces": [ { "traceId": "…", "name": "GET", "start": "…", "durationMs": 12, "statusCode": 0, "screen": "home" } ],
  "limits": { "events": { "loaded": 15, "truncated": false }, "rootSpans": { "loaded": 3, "truncated": false } }
}
```

- `steps` are ordered by `timeNs`; on equal times the session starts first,
  and a flow starts before what happens in it and ends after.
- `kind: session` is a `session.start` event; `previousSessionId` links the
  session it continues. It never counts as a step of a flow.
- `outcomeReason` / `flows[].reason` come from `journey.outcome_reason`.
- `flows[].status` is `open` when a start arrived and no end did. The UI
  shows it as "no conclusion", never as abandoned.
- `flows[].attempt` counts runs of the same flow code in the session.
- `extra` holds attributes outside the journey contract.
- In `/api/traces/:traceId`, span `attributes` and `resource` include the
  keys stored as fields again, as the app sent them.
- `otherTraces` are root spans of the session whose trace no step points to.
- `limits` tells the UI when it did not load everything (`MAX_JOURNEY_EVENTS`,
  `MAX_TRACE_SPANS`).

## `GET /api/traces/:traceId`

```json
{
  "traceId": "…",
  "rows": [ { "span": { }, "depth": 0, "missingParent": false, "offsetMs": 0 } ],
  "start": "…", "durationMs": 675, "services": ["demo-shop"], "errorCount": 2,
  "missingParents": 0, "truncated": false,
  "events": [ { } ]
}
```

`rows` are depth first, children by start time. A span whose parent never
arrived is a root with `missingParent: true`. `events` are the journey events
linked to the trace. 404 when neither spans nor events exist.

## `GET /api/facets?from&to`

Distinct `services`, `versions`, `platforms`, `environments` and flow codes
(`flows`) seen in the window, for filter dropdowns. Read from `rollups`.

## `GET /api/overview`

The overview page: how the journeys went in a period and what changed
against another one. Reads only `rollups`.

| Parameter | Default | |
|---|---|---|
| `period` | `24h` | `24h` (hourly slots), `7d` or `30d` (daily slots) |
| `compare` | `previous` | `previous`: the period just before. `week`: the same hours a week earlier (`24h` only) |
| `tz` | `UTC` | IANA time zone of the reader; days start at its midnight |
| `service`, `version`, `platform`, `environment` | | exact match |

```json
{
  "period": { "key": "24h", "from": "…", "to": "…" },
  "previous": { "key": "previous", "from": "…", "to": "…" },
  "slot": "hour", "slots": ["…"], "updatedAt": "…", "minVolume": 200,
  "sessions": { "now": 2878, "before": 2886, "series": [ ] },
  "failedSessions": { "now": 428, "before": 381, "series": [ ] },
  "flows": [ { "code": "login", "label": "Login", "started": 2878, "success": 2678, "failure": 200,
               "cancelled": 0, "completed": 0, "open": 0, "p95Ms": 5210,
               "before": { "started": 2885, "failure": 114, "open": 0, "p95Ms": 5663 },
               "series": { "started": [ ], "failure": [ ], "ended": [ ] },
               "reasons": [ { "outcome": "failure", "reason": "blockedAccount", "errorType": null, "now": 92, "before": 38 } ],
               "byVersion": [ { "version": "1.4.0", "platform": "ios", "started": 736, "failure": 110,
                                "before": { "n": 742, "failure": 30 }, "series": { "started": [ ], "failure": [ ] } } ] } ],
  "actions": [ { "code": "pay", "label": "Pagou", "n": 1472, "failure": 38, "measured": 1472, "p95Ms": 2877,
                 "before": { "n": 1450, "failure": 26, "measured": 1450, "p95Ms": 1973 } } ],
  "versions": [ { "version": "1.4.0", "platform": "ios", "sessions": 736, "failedSessions": 156,
                  "before": { "sessions": 742, "failedSessions": 95 }, "flows": { "login": { "n": 736, "failure": 110 } } } ],
  "changes": [ { "type": "failure", "direction": "worse", "code": "login", "label": "Login",
                 "now": { "n": 2878, "failure": 200 }, "before": { "n": 2885, "failure": 114 },
                 "since": "…", "where": { "version": "1.4.0", "platform": "ios", "share": 0.8 },
                 "reason": { "reason": "blockedAccount", "errorType": null, "shareBefore": 0.37, "shareNow": 0.69, "beforeScope": "version" },
                 "impact": 86 },
               { "type": "duration", "direction": "worse", "code": "pay", "label": "Pagou",
                 "nowMs": 2877, "beforeMs": 1973, "measured": 1472, "impact": 1332 } ]
}
```

- Slots cover whole hours; the last one is the current, partial hour. To
  compare like with like, the previous period's last hour counts only the
  part of the current hour that has passed, so `before` can have decimals.
- A flow run counts in the slot it started; `open` is started minus ended
  (no end received yet).
- `p95Ms` comes from the duration histogram (null under 20 values).
- `changes`, worst first. A comparison needs `OVERVIEW_MIN_VOLUME` (200)
  runs or measured actions on both sides, a two-proportion z score of at
  least 3, and at least 0.5 percentage point and 20% of the earlier rate (25%
  and 200 ms for durations). `where` is the version and platform holding at
  least half of the difference; `reason` the reason whose share of the
  failures moved at least 10 points; `since` the first slot of the last
  stretch above the midpoint between the two rates. They say where to look,
  not why.

## `GET /api/config`

Settings of this deployment that the UI needs.

```json
{ "traceLink": { "template": "https://logs.example.com/app/discover#/?query=trace.id:{traceId}", "label": "Abrir no log" } }
```

`traceLink` is null unless `TRACE_LINK_TEMPLATE` is set (`TRACE_LINK_LABEL`
for the label, default "Abrir no log"). The UI replaces every `{traceId}`
with the URL-encoded trace id and shows the link on the trace page and on
each journey step that has a trace.

## `GET /api/status`

```json
{ "aggregatedUpTo": "2026-10-28T12:00:00.000Z" }
```

Everything received up to `aggregatedUpTo` is in `sessions` and `rollups`;
null before the aggregator's first run.
