// Sends fictional shop sessions to an OTLP endpoint, so the dashboard has
// something to show. Usage: npm run seed -- [--endpoint http://localhost:4318] [--sessions 12]
import { parseArgs } from 'node:util';
import { encode, syntheticSession } from './lib/synthetic.js';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string', default: process.env.OTLP_ENDPOINT ?? 'http://localhost:4318' },
    sessions: { type: 'string', default: '12' },
  },
});
const endpoint = values.endpoint!.replace(/\/$/, '');
const total = Number(values.sessions);

async function send(signal: 'traces' | 'logs', body: Uint8Array) {
  const r = await fetch(`${endpoint}/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: body as BodyInit,
  });
  if (!r.ok) throw new Error(`${signal}: HTTP ${r.status} ${await r.text()}`);
}

const installs = ['demo-install-1', 'demo-install-2', 'demo-install-3', 'demo-install-4', 'demo-install-5'];
const now = Date.now();
const last = new Map<string, string>();
for (let i = 0; i < total; i++) {
  const installationId = installs[i % installs.length]!;
  const s = syntheticSession({
    start: now - (total - i) * 17 * 60_000,
    installationId,
    // Every other later session continues the previous one of its
    // installation (the app stayed open and the session expired).
    previousSessionId: i % 2 === 0 ? last.get(installationId) : undefined,
    userId: `demo-user-${(i % installs.length) + 1}`,
    platform: i % 3 === 0 ? 'android' : 'ios',
    version: i % 4 === 0 ? '1.3.2' : '1.4.0',
    loginFails: i % 7 === 3,
    paymentFails: i % 5 === 2,
    checkoutOpen: i % 6 === 4,
  });
  last.set(installationId, s.sessionId);
  await send('traces', encode('traces', s.traces));
  await send('logs', encode('logs', s.logs));
  console.log(`session ${s.sessionId}  ${s.counts.events} events, ${s.counts.spans} spans`);
}
console.log(`\n${total} fictional sessions sent to ${endpoint}`);
