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

const devices = ['demo-device-1', 'demo-device-2', 'demo-device-3', 'demo-device-4', 'demo-device-5'];
const now = Date.now();
for (let i = 0; i < total; i++) {
  const s = syntheticSession({
    start: now - (total - i) * 17 * 60_000,
    deviceId: devices[i % devices.length]!,
    userId: `demo-user-${(i % devices.length) + 1}`,
    platform: i % 3 === 0 ? 'android' : 'ios',
    version: i % 4 === 0 ? '1.3.2' : '1.4.0',
    loginFails: i % 7 === 3,
    paymentFails: i % 5 === 2,
    checkoutOpen: i % 6 === 4,
  });
  await send('traces', encode('traces', s.traces));
  await send('logs', encode('logs', s.logs));
  console.log(`session ${s.sessionId}  ${s.counts.events} events, ${s.counts.spans} spans`);
}
console.log(`\n${total} fictional sessions sent to ${endpoint}`);
