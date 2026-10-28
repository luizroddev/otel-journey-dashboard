# Query API

JSON over HTTP, read by the dashboard UI. Served under `/api` in `all` and
`query` modes. It is the dashboard's own read model, not OTLP JSON.

When `API_TOKEN` is set, every request needs `Authorization: Bearer <token>`
(the UI reads the token from `localStorage.apiToken`). In a company
environment, put the dashboard behind the existing SSO proxy instead.

Errors: `{ "error": "<message>" }` with 400 (invalid parameters), 401, 404.

## `GET /api/sessions`

| Parameter | Default | |
|---|---|---|
| `from`, `to` | last 24 h | ISO 8601. Window clamped to `MAX_WINDOW_DAYS` (31) |
| `deviceId`, `installationId`, `userId`, `sessionId` | | exact match |
| `service`, `version`, `platform`, `environment` | | exact match |
| `onlyErrors` | `false` | `true`: `errorCount > 0` |
| `limit` | 50 | at most `MAX_PAGE_SIZE` (200) |
| `before` | | cursor: the previous page's `nextBefore` |

Sessions whose `lastSeen` falls in the window, newest first.

```json
{
  "items": [ { "_id": "…", "deviceId": null, "installationId": "…", "previousSessionId": null,
               "userIds": [], "firstSeen": "…", "lastSeen": "…",
               "eventCount": 15, "spanCount": 6, "errorCount": 1, "services": [], "versions": [],
               "platforms": [], "environments": [] } ],
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

Distinct `services`, `versions`, `platforms` and `environments` of sessions
in the window, for filter dropdowns.
