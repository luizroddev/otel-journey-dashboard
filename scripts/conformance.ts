// Conformance check for any receiver that writes the dashboard's MongoDB
// (docs/storage-schema.md): sends one fictional session to its OTLP
// endpoint, then checks what landed in MongoDB.
//
//   npm run conformance -- --endpoint http://localhost:4318 \
//     --mongo mongodb://localhost:27017 --db otel_journey [--header "Authorization: Bearer x"]
//
// A receiver that stamps device.id / overrides user.id from the
// authenticated context passes --expect-device <id> / --expect-user <id>.
// Without --expect-device, deviceId must stay null: it never comes from the
// payload.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { encode, syntheticSession } from './lib/synthetic.js';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string', default: 'http://localhost:4318' },
    mongo: { type: 'string', default: 'mongodb://localhost:27017' },
    db: { type: 'string', default: 'otel_journey' },
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
  const events = await db.collection('events').find({ sessionId: s.sessionId }).sort({ time: 1 }).toArray();
  const spans = await db.collection('spans').find({ sessionId: s.sessionId }).toArray();
  const session = await db.collection('sessions').findOne({ _id: s.sessionId as never });
  const device = values['expect-device'] ?? null;
  const user = values['expect-user'] ?? `${installationId}-user`;

  check(events.length === s.counts.events, 'every log record is one document in `events`, resends included', `${events.length}/${s.counts.events}`);
  check(spans.length === (s.counts.spans / 3) * 2, 'every app span is one document in `spans`, resends included', `${spans.length}`);
  check(!!session, 'a `sessions` summary exists for session.id');

  const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());
  const isNs = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  const isHex = (v: unknown, n: number) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);

  check(events.every((e) => isDate(e.time) && isNs(e.timeNs)), 'events: time is a Date, timeNs a decimal string');
  check(events.every((e) => isDate(e.expireAt) && isDate(e.receivedAt)), 'events: receivedAt and expireAt are Dates');
  check(events.every((e) => typeof e.eventName === 'string'), 'events: eventName is set');
  const uidOf = (e: Record<string, unknown>) =>
    (e.attributes as { key: string; value: unknown }[]).find((a) => a.key === 'log.record.uid')?.value;
  check(events.every((e) => String(e._id) === `${e.service}:${uidOf(e)}`), 'events: _id is {service}:{log.record.uid}');
  check(events.every((e) => e.deviceId === device), 'events: deviceId', `expected ${device}`);
  check(events.every((e) => e.installationId === installationId), 'events: installationId from app.installation.id');
  check(events.some((e) => e.userId === user) && events.some((e) => e.userId === null), 'events: userId set after login, null before');
  check(events.every((e) => Array.isArray(e.attributes) && Array.isArray(e.resource)), 'events: attributes and resource are [{key, value}]');
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

  if (session) {
    check(session.eventCount === s.counts.events, 'sessions: eventCount', `${session.eventCount}`);
    check(session.errorCount === (s.counts.events > 0 ? 1 : 0), 'sessions: errorCount counts one per failed operation', `${session.errorCount}`);
    check(session.deviceId === device, 'sessions: deviceId');
    check(session.installationId === installationId, 'sessions: installationId');
    check(Array.isArray(session.userIds) && session.userIds.includes(user), 'sessions: userIds');
    check(isDate(session.firstSeen) && isDate(session.lastSeen) && session.firstSeen <= session.lastSeen, 'sessions: firstSeen <= lastSeen');
  }
} finally {
  await client.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
