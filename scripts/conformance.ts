// Conformance check for any receiver that writes the dashboard's MongoDB
// (docs/storage-schema.md): sends one fictional session to its OTLP
// endpoint, then checks the `spans` and `events` it inserted. Sessions and
// rollups are the dashboard's job, so they are not checked here.
//
//   npm run conformance -- --endpoint http://localhost:4318 \
//     --mongo mongodb://localhost:27017 --db otel_journey [--prefix journey_] \
//     [--header "Authorization: Bearer x"]
//
// --prefix (default: COLLECTION_PREFIX) is the writer's collection prefix:
// it then checks `journey_spans` and `journey_events`.
//
// A receiver that stamps device.id / overrides user.id from the
// authenticated context passes --expect-device <id> / --expect-user <id>.
// Without --expect-device, deviceId must stay null: it never comes from the
// payload.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { ProjectedKeys } from '../server/src/model.js';
import { encode, syntheticSession } from './lib/synthetic.js';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string', default: 'http://localhost:4318' },
    mongo: { type: 'string', default: 'mongodb://localhost:27017' },
    db: { type: 'string', default: 'otel_journey' },
    prefix: { type: 'string', default: process.env.COLLECTION_PREFIX ?? '' },
    header: { type: 'string', multiple: true, default: [] },
    'expect-device': { type: 'string' },
    'expect-user': { type: 'string' },
    'wait-ms': { type: 'string', default: '1500' },
  },
});

const results: { ok: boolean; check: string; detail?: string }[] = [];
const check = (ok: boolean, name: string, detail?: string) => results.push({ ok, check: name, detail });

const headers: Record<string, string> = { 'content-type': 'application/x-protobuf' };
for (const h of values.header!) {
  const i = h.indexOf(':');
  if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
}

const installationId = `conformance-${randomBytes(4).toString('hex')}`;
const s = syntheticSession({ start: Date.now() - 30_000, installationId, userId: `${installationId}-user` });
const endpoint = values.endpoint!.replace(/\/$/, '');
const post = (signal: 'traces' | 'logs') =>
  fetch(`${endpoint}/v1/${signal}`, {
    method: 'POST',
    headers,
    body: encode(signal, signal === 'traces' ? s.traces : s.logs) as BodyInit,
  });
for (const signal of ['traces', 'logs'] as const) {
  const r = await post(signal);
  check(r.ok, `POST /v1/${signal} is accepted`, `HTTP ${r.status}`);
}
// OTLP clients resend after a timeout: the same requests again must not
// create documents.
for (const signal of ['traces', 'logs'] as const) await post(signal);
await new Promise((r) => setTimeout(r, Number(values['wait-ms'])));

const client = new MongoClient(values.mongo!);
await client.connect();
try {
  const db = client.db(values.db!);
  const events = await db.collection(`${values.prefix}events`).find({ sessionId: s.sessionId }).sort({ time: 1 }).toArray();
  const spans = await db.collection(`${values.prefix}spans`).find({ sessionId: s.sessionId }).toArray();
  const device = values['expect-device'] ?? null;
  const user = values['expect-user'] ?? `${installationId}-user`;

  check(events.length === s.counts.events, 'every log record is one document in `events`, resends included', `${events.length}/${s.counts.events}`);
  check(spans.length === (s.counts.spans / 3) * 2, 'every app span is one document in `spans`, resends included', `${spans.length}`);

  const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());
  const isNs = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  const isHex = (v: unknown, n: number) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);

  check(events.every((e) => isDate(e.time) && isNs(e.timeNs)), 'events: time is a Date, timeNs a decimal string');
  check(events.every((e) => isDate(e.expireAt) && isDate(e.receivedAt)), 'events: receivedAt and expireAt are Dates');
  check(events.every((e) => typeof e.eventName === 'string'), 'events: eventName is set');
  const ids = new Set(s.uids.map((u) => `demo-shop:${u}`));
  check(events.every((e) => ids.has(String(e._id))), 'events: _id is {service}:{log.record.uid}');
  check(events.every((e) => e.deviceId === device), 'events: deviceId', `expected ${device}`);
  check(events.every((e) => e.installationId === installationId), 'events: installationId from app.installation.id');
  check(events.some((e) => e.userId === user) && events.some((e) => e.userId === null), 'events: userId set after login, null before');
  type Pairs = { key: string; value: unknown }[];
  const lean = (list: unknown, projected: Set<string>) =>
    Array.isArray(list) && (list as Pairs).every((a) => typeof a.key === 'string' && !projected.has(a.key));
  check(events.every((e) => lean(e.attributes, ProjectedKeys.events)), 'events: attributes are [{key, value}] without the keys stored as fields');
  check(events.every((e) => !('resource' in e)), 'events: no resource (it is the same for the whole session)');
  check(
    events.some((e) => (e.attributes as Pairs).some((a) => a.key === 'app.login.method')),
    "events: the app's own attributes are kept",
  );
  const measured = events.filter((e) => e.eventName === 'journey.action' && e.durationMs !== null);
  check(measured.length === 3, 'events: measured actions have durationMs', `${measured.length}`);
  check(measured.every((e) => isHex(e.traceId, 32) && isHex(e.spanId, 16)), 'events: measured actions carry hex traceId/spanId');
  check(events.filter((e) => e.eventName === 'journey.screen.view').every((e) => e.traceId === null), 'events: screen views outside spans have traceId null');
  check(events.filter((e) => e.outcome).every((e) => ['success', 'failure', 'cancelled', 'completed'].includes(e.outcome)), 'events: outcome is one of the four values');
  check(events.filter((e) => e.eventName?.startsWith('journey.flow')).every((e) => isHex(e.flowInstanceId, 32)), 'events: flow events carry flowInstanceId');
  check(events.filter((e) => e.outcome === 'failure').every((e) => typeof e.outcomeReason === 'string'), 'events: failures carry outcomeReason');
  check(events.filter((e) => e.eventName === 'session.start').length === 1, 'events: one session.start');

  check(spans.every((x) => isHex(x.traceId, 32) && isHex(x.spanId, 16)), 'spans: hex traceId/spanId');
  check(spans.every((x) => String(x._id) === `${x.service}:${x.traceId}:${x.spanId}`), 'spans: _id is {service}:{traceId}:{spanId}');
  check(spans.every((x) => isDate(x.start) && isDate(x.end) && isNs(x.startNs) && typeof x.durationMs === 'number'), 'spans: start/end Dates, startNs string, durationMs number');
  check(spans.some((x) => x.parentSpanId === null) && spans.some((x) => isHex(x.parentSpanId, 16)), 'spans: parentSpanId null for roots, hex otherwise');
  check(spans.some((x) => x.statusCode === 2), 'spans: statusCode is the OTLP number');
  check(spans.every((x) => isDate(x.receivedAt) && isDate(x.expireAt)), 'spans: receivedAt and expireAt are Dates');
  check(
    spans.every((x) => lean(x.attributes, ProjectedKeys.spans) && lean(x.resource, ProjectedKeys.spans)),
    'spans: attributes and resource without the keys stored as fields',
  );
  check(spans.every((x) => x.sessionId === s.sessionId && x.installationId === installationId), 'spans: sessionId and installationId');
} finally {
  await client.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
