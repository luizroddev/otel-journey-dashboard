// End to end against a real MongoDB: OTLP in, query API out.
// Runs when MONGO_URL is set (docker compose up -d mongo; MONGO_URL=mongodb://localhost:27017).
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../server/src/config.js';
import { apiRoutes } from '../server/src/http/api.js';
import { ingestRoutes } from '../server/src/http/ingest.js';
import { connect, ensureIndexes, type Store } from '../server/src/store/mongo.js';
import { encode, syntheticSession } from '../scripts/lib/synthetic.js';

const url = process.env.MONGO_URL;

const config: Config = {
  mode: 'all',
  mongoUrl: url ?? '',
  mongoDb: `otel_journey_test_${process.pid}`,
  otlpPort: 0,
  httpPort: 0,
  host: '127.0.0.1',
  retentionDays: 30,
  maxBodyBytes: 1024 * 1024,
  maxRecordsPerRequest: 1000,
  apiToken: null,
  ingestToken: null,
  trustedDeviceHeader: null,
  trustedUserHeader: null,
  maxWindowDays: 31,
  maxPageSize: 200,
  maxJourneyEvents: 5000,
  maxTraceSpans: 2000,
};

describe.skipIf(!url)('MongoDB end to end', () => {
  let store: Store;
  let ingest: ReturnType<typeof ingestRoutes>;
  let api: ReturnType<typeof apiRoutes>;

  beforeAll(async () => {
    store = await connect(url!, config.mongoDb);
    await ensureIndexes(store);
    ingest = ingestRoutes(store, config);
    api = apiRoutes(store, config);
  });

  afterAll(async () => {
    await store?.db.dropDatabase();
    await store?.close();
  });

  const post = (path: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    ingest.request(path, {
      method: 'POST',
      body: body as BodyInit,
      headers: { 'content-type': 'application/x-protobuf', ...headers },
    });
  const get = async (path: string) => {
    const r = await api.request(`/${path}`);
    return { status: r.status, body: (await r.json()) as any };
  };

  it('ingests a session and serves its journey and traces', async () => {
    const s = syntheticSession({ start: Date.now() - 60_000, installationId: 'install-e2e', userId: 'user-e2e' });
    expect((await post('/v1/traces', encode('traces', s.traces))).status).toBe(200);
    // gzip, like most OTLP exporters send
    const logs = await post('/v1/logs', gzipSync(encode('logs', s.logs)), { 'content-encoding': 'gzip' });
    expect(logs.status).toBe(200);
    expect(logs.headers.get('content-type')).toBe('application/x-protobuf');

    // A resend changes nothing.
    await post('/v1/logs', encode('logs', s.logs));
    await post('/v1/traces', encode('traces', s.traces));

    const list = await get('sessions?installationId=install-e2e');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const summary = list.body.items[0];
    expect(summary._id).toBe(s.sessionId);
    expect(summary.installationId).toBe('install-e2e');
    expect(summary.deviceId).toBeNull();
    expect(summary.previousSessionId).toBeNull();
    expect(summary.eventCount).toBe(s.counts.events);
    // Backend spans carry no session.id: they are stored, not counted.
    expect(summary.spanCount).toBe((s.counts.spans / 3) * 2);
    expect(summary.userIds).toEqual(['user-e2e']);
    expect(summary.platforms).toEqual(['ios']);
    // One failed login attempt; its span is not counted twice.
    expect(summary.errorCount).toBe(1);

    expect((await get('sessions?userId=user-e2e')).body.items).toHaveLength(1);
    expect((await get('sessions?onlyErrors=true&installationId=install-e2e')).body.items).toHaveLength(1);
    expect((await get('sessions?userId=nobody')).body.items).toHaveLength(0);

    const journey = await get(`sessions/${s.sessionId}/journey`);
    expect(journey.status).toBe(200);
    expect(journey.body.steps).toHaveLength(s.counts.events);
    expect(journey.body.flows.map((f: any) => f.status)).toEqual(['success', 'success']);
    expect(journey.body.limits.events.truncated).toBe(false);

    const failed = journey.body.steps.find((x: any) => x.outcome === 'failure');
    const trace = await get(`traces/${failed.traceId}`);
    expect(trace.status).toBe(200);
    expect(trace.body.rows.map((r: any) => r.depth)).toEqual([0, 1, 2]);
    expect(trace.body.events).toHaveLength(1);
    expect(trace.body.errorCount).toBeGreaterThan(0);

    // The next session of the installation links back through session.start.
    const next = syntheticSession({
      start: Date.now() - 30_000,
      installationId: 'install-e2e-next',
      userId: 'user-e2e',
      previousSessionId: s.sessionId,
    });
    await post('/v1/logs', encode('logs', next.logs));
    const linked = (await get('sessions?installationId=install-e2e-next')).body.items[0];
    expect(linked.previousSessionId).toBe(s.sessionId);

    const facets = await get('facets');
    expect(facets.body.services).toContain('demo-shop');
  });

  it('rejects what it cannot take', async () => {
    const bad = await ingest.request('/v1/logs', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(bad.status).toBe(415);
    const garbage = await post('/v1/traces', new Uint8Array([0xff, 0xff, 0xff]));
    expect(garbage.status).toBe(400);
    expect((await get('sessions?from=nope')).status).toBe(400);
    expect((await get('traces/0123')).status).toBe(404);
  });
});
