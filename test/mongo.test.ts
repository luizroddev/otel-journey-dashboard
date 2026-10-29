// End to end against a real MongoDB: OTLP in, query API out.
// Runs when MONGO_URL is set (docker compose up -d mongo; MONGO_URL=mongodb://localhost:27017).
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateOnce } from '../server/src/aggregate/aggregator.js';
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
  collectionPrefix: '',
  basePath: '/',
  traceLink: null,
  otlpPort: 0,
  httpPort: 0,
  host: '127.0.0.1',
  retentionDays: 30,
  aggregator: true,
  aggregateEveryMs: 15_000,
  aggregateLagMs: 0,
  rollupRetentionDays: 400,
  overviewMinVolume: 1,
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
    await ensureIndexes(store, { raw: true, derived: true });
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
  const aggregate = (owner = 'test') =>
    aggregateOnce(store, { now: new Date(), lagMs: 0, chunkMs: 60_000, owner, leaseMs: 60_000, rollupRetentionDays: 400 });
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
    expect(await store.events.countDocuments({ sessionId: s.sessionId })).toBe(s.counts.events);
    // Writers only insert: sessions come from the aggregator.
    expect(await store.sessions.countDocuments()).toBe(0);
    expect((await aggregate())!.records).toBe(s.counts.events + (s.counts.spans / 3) * 2);

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
    // Drill-down from the overview: what failed, and why.
    expect((await get('sessions?failedAction=confirmLogin&reason=invalidPassword')).body.items).toHaveLength(1);
    expect((await get('sessions?failedAction=confirmLogin&reason=blockedAccount')).body.items).toHaveLength(0);
    expect((await get('sessions?failedFlow=login')).body.items).toHaveLength(0);
    expect((await get('sessions?flow=checkout')).body.items).toHaveLength(1);

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
    await aggregate();
    const linked = (await get('sessions?installationId=install-e2e-next')).body.items[0];
    expect(linked.previousSessionId).toBe(s.sessionId);

    const facets = await get('facets');
    expect(facets.body.services).toContain('demo-shop');
    expect(facets.body.flows).toEqual(['checkout', 'login']);
    expect((await get('status')).body.aggregatedUpTo).not.toBeNull();

    const overview = (await get('overview?period=24h&tz=America/Sao_Paulo')).body;
    expect(overview.slots).toHaveLength(24);
    expect(overview.sessions.now).toBe(2);
    const login = overview.flows.find((f: any) => f.code === 'login');
    expect([login.label, login.started, login.success]).toEqual(['Login', 2, 2]);
    expect(overview.actions.find((a: any) => a.code === 'confirmLogin').failure).toBe(2);
    expect(overview.versions[0]).toMatchObject({ version: '1.4.0', platform: 'ios', sessions: 2 });
    expect((await get('overview?period=7d')).body.slot).toBe('day');
  });

  it('rollups count flows, actions, reasons and sessions per hour', async () => {
    const r = (kind: 'session' | 'flow' | 'action', code: string) => store.rollups.find({ kind, code }).toArray();
    const sum = (docs: any[], path: (d: any) => number | undefined) => docs.reduce((n, d) => n + (path(d) ?? 0), 0);
    const login = await r('flow', 'login');
    expect(sum(login, (d) => d.n)).toBe(2);
    expect(sum(login, (d) => d.success)).toBe(2);
    expect(login[0]!.label).toBe('Login');
    const confirm = await r('action', 'confirmLogin');
    expect(sum(confirm, (d) => d.n)).toBe(4);
    expect(sum(confirm, (d) => d.failure)).toBe(2);
    expect(sum(confirm, (d) => d.reasons?.failure?.invalidPassword)).toBe(2);
    expect(sum(confirm, (d) => Object.values(d.dur ?? {}).reduce((a: number, b) => a + (b as number), 0))).toBe(4);
    const sessions = await r('session', '');
    expect(sum(sessions, (d) => d.n)).toBe(2);
    // The second session only sent events, with a failed login attempt too.
    expect(sum(sessions, (d) => d.failed)).toBe(2);
    expect(confirm[0]!.version).toBe('1.4.0');
    expect(confirm[0]!.platform).toBe('ios');
  });

  it('a chunk redone after a crash, or by another instance, never counts twice', async () => {
    const before = await snapshot();
    const job = (await store.jobs.findOne({ _id: 'aggregate' }))!;
    // As if the last chunk was applied and the process died before marking it done.
    const s2 = syntheticSession({ start: Date.now() - 10_000, installationId: 'install-crash', userId: 'user-crash' });
    await post('/v1/logs', encode('logs', s2.logs));
    const run = (await aggregate())!;
    expect(run.chunks).toBeGreaterThan(0);
    const after = await snapshot();
    await store.jobs.updateOne({ _id: 'aggregate' }, { $set: { done: job.done, pending: run.done } });
    await aggregate();
    expect(await snapshot()).toEqual(after);
    expect(after.events).toBe(before.events + s2.counts.events);

    // Another instance holding a live lease: this one waits.
    await store.jobs.updateOne({ _id: 'aggregate' }, { $set: { owner: 'other', leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await aggregate()).toBeNull();
    await store.jobs.updateOne({ _id: 'aggregate' }, { $set: { leaseUntil: new Date(0) } });
    expect(await aggregate()).not.toBeNull();
  });

  it('finds the sessions of several devices, installations or users at once', async () => {
    const ids = async (q: string) => ((await get(`sessions?${q}`)).body.items as any[]).map((i) => i.installationId).sort();
    expect(await ids('installationId=install-e2e,install-e2e-next')).toEqual(['install-e2e', 'install-e2e-next']);
    // Spaces, empty values and repeats are ignored.
    expect(await ids('installationId=%20install-e2e,,install-e2e,')).toEqual(['install-e2e']);
    expect(await ids('installationId=install-e2e,nobody')).toEqual(['install-e2e']);
    expect(await ids('userId=nobody,user-e2e')).toEqual(['install-e2e', 'install-e2e-next']);
    expect(await ids('userId=user-e2e&installationId=install-e2e-next,nobody')).toEqual(['install-e2e-next']);
    expect(await ids('deviceId=device-a,device-b')).toEqual([]);

    const tooMany = Array.from({ length: 51 }, (_, i) => `device-${i}`).join(',');
    expect((await get(`sessions?deviceId=${tooMany}`)).status).toBe(400);
  });

  it('keeps its collections under COLLECTION_PREFIX', async () => {
    const prefixed = await connect(url!, config.mongoDb, 'journey_');
    try {
      await ensureIndexes(prefixed, { raw: true, derived: true });
      const s = syntheticSession({ start: Date.now() - 20_000, installationId: 'install-prefix', userId: 'user-prefix' });
      const receiver = ingestRoutes(prefixed, config);
      for (const signal of ['traces', 'logs'] as const) {
        const body = encode(signal, signal === 'traces' ? s.traces : s.logs) as BodyInit;
        await receiver.request(`/v1/${signal}`, { method: 'POST', body, headers: { 'content-type': 'application/x-protobuf' } });
      }
      await aggregateOnce(prefixed, { now: new Date(), lagMs: 0, chunkMs: 60_000, owner: 'prefixed', leaseMs: 60_000, rollupRetentionDays: 400 });

      const names = (await store.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['spans', 'events', 'sessions', 'rollups', 'jobs'].map((n) => `journey_${n}`)));
      const items = (await (await apiRoutes(prefixed, config).request('/sessions?installationId=install-prefix')).json()) as any;
      expect(items.items).toHaveLength(1);
      expect(await prefixed.events.countDocuments({ sessionId: s.sessionId })).toBe(s.counts.events);
      // Nothing of it in the unprefixed collections, and nothing of theirs here.
      expect(await store.events.countDocuments({ sessionId: s.sessionId })).toBe(0);
      expect((await get('sessions?installationId=install-prefix')).body.items).toHaveLength(0);
      expect(await prefixed.sessions.countDocuments({ installationId: 'install-e2e' })).toBe(0);
    } finally {
      await prefixed.close();
    }
  });

  const snapshot = async () => {
    const sessions = await store.sessions.find().sort({ _id: 1 }).project({ upTo: 0 }).toArray();
    const rollups = await store.rollups.find().sort({ _id: 1 }).project({ upTo: 0 }).toArray();
    return { sessions, rollups, events: sessions.reduce((n, d) => n + d.eventCount, 0) };
  };

  it('rejects what it cannot take', async () => {
    const bad = await ingest.request('/v1/logs', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(bad.status).toBe(415);
    const garbage = await post('/v1/traces', new Uint8Array([0xff, 0xff, 0xff]));
    expect(garbage.status).toBe(400);
    expect((await get('sessions?from=nope')).status).toBe(400);
    expect((await get('traces/0123')).status).toBe(404);
  });
});
