// Sends fictional shop sessions to an OTLP endpoint, so the dashboard has
// something to show: two days of sessions with a daily rhythm, and a made-up
// incident in the last hours (more login failures on iOS 1.4.0, slower
// payments) for the overview to find.
//
//   npm run seed -- [--endpoint http://localhost:4318] [--sessions 6000] [--days 2] [--seed 1]
import { parseArgs } from 'node:util';
import { encode, syntheticSession, type SyntheticSession } from './lib/synthetic.js';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string', default: process.env.OTLP_ENDPOINT ?? 'http://localhost:4318' },
    sessions: { type: 'string', default: '6000' },
    days: { type: 'string', default: '2' },
    seed: { type: 'string', default: '1' },
  },
});
const endpoint = values.endpoint!.replace(/\/$/, '');
const total = Number(values.sessions);
const days = Number(values.days);

// Small deterministic generator (mulberry32), so the same seed gives the same story.
let state = Number(values.seed) >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p: number) => random() < p;
const pick = <T>(items: [T, number][]): T => {
  let r = random() * items.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[items.length - 1]![0];
};
/** Around `median` ms, with a long tail. */
const latency = (median: number) => Math.round(median * Math.exp(0.45 * Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random())));

const HOUR = 3_600_000;
const now = Date.now();
const from = now - days * 24 * HOUR;
const loginIncident = now - 12 * HOUR;
const paymentIncident = now - 7 * HOUR;
// More sessions in the afternoon and evening (UTC-3) than at night.
const busy = (t: number) => {
  const h = (new Date(t).getUTCHours() + 21) % 24;
  return h < 6 ? 0.2 : h < 9 ? 0.6 : h < 12 ? 0.85 : 1;
};

const starts: number[] = [];
while (starts.length < total) {
  const t = from + random() * (now - from - 5 * 60_000);
  if (random() < busy(t)) starts.push(t);
}
starts.sort((a, b) => a - b);

const installs = Array.from({ length: Math.max(5, Math.round(total / 3)) }, (_, i) => `demo-install-${i + 1}`);
const last = new Map<string, string>();
const sessions: SyntheticSession[] = [];
for (const start of starts) {
  const installationId = installs[Math.floor(random() * installs.length)]!;
  const platform = chance(0.45) ? 'ios' : 'android';
  const version = chance(0.6) ? '1.4.0' : '1.3.2';
  const incident = platform === 'ios' && version === '1.4.0' && start > loginIncident;
  const slowPayments = start > paymentIncident;
  const s = syntheticSession({
    start,
    installationId,
    previousSessionId: chance(0.3) ? last.get(installationId) : undefined,
    userId: `demo-user-${installationId.slice('demo-install-'.length)}`,
    platform,
    version,
    wrongPasswordFirst: chance(0.08),
    loginFails: chance(incident ? 0.2 : 0.04),
    loginFailReason: incident
      ? pick([['blockedAccount', 7], ['invalidPassword', 2], ['sessionExpired', 1]])
      : pick([['invalidPassword', 11], ['blockedAccount', 5], ['sessionExpired', 4]]),
    loginMs: latency(450),
    checkout: chance(0.55),
    cancelCheckout: chance(0.04),
    paymentFails: chance(slowPayments ? 0.05 : 0.025),
    paymentMs: latency(slowPayments ? 1600 : 900),
    checkoutOpen: chance(0.04),
    returns: chance(0.06) ? pick([['success', 16], ['cancelled', 3], ['failure', 1]]) : undefined,
  });
  last.set(installationId, s.sessionId);
  sessions.push(s);
}

async function send(signal: 'traces' | 'logs', body: Uint8Array) {
  const r = await fetch(`${endpoint}/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: body as BodyInit,
  });
  if (!r.ok) throw new Error(`${signal}: HTTP ${r.status} ${await r.text()}`);
}

// Several sessions per request, like an app that batches.
const batch = 25;
let records = 0;
for (let i = 0; i < sessions.length; i += batch) {
  const part = sessions.slice(i, i + batch);
  const traces = { resourceSpans: part.flatMap((s) => s.traces.resourceSpans as unknown[]) };
  const logs = { resourceLogs: part.flatMap((s) => s.logs.resourceLogs as unknown[]) };
  await send('traces', encode('traces', traces));
  await send('logs', encode('logs', logs));
  records += part.reduce((n, s) => n + s.counts.events + s.counts.spans, 0);
  if ((i / batch) % 40 === 0) console.log(`${Math.min(i + batch, sessions.length)}/${sessions.length} sessions`);
}
console.log(`\n${sessions.length} fictional sessions (${records} records) over ${days} day(s) sent to ${endpoint}`);
console.log('The dashboard shows them once its aggregator runs (about a minute).');
