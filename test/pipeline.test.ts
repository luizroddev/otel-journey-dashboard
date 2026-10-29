import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeBasePath, type Config } from '../server/src/config.js';
import { idList } from '../server/src/http/api.js';
import { dashboardRoutes, indexHtml } from '../server/src/http/dashboard.js';
import type { Store } from '../server/src/store/mongo.js';
import { traceLinkUrl } from '../web/src/traceLink.js';
import { mapLogs, mapSpans } from '../server/src/ingest/mapping.js';
import { decodeLogs, decodeTraces } from '../server/src/otlp/decode.js';
import { buildJourney } from '../server/src/query/journey.js';
import { buildTrace, withContext } from '../server/src/query/trace.js';
import { durationBucket, escapeKey, unescapeKey } from '../server/src/aggregate/aggregator.js';
import { findChanges, percentile, periodWindow, type FlowStat } from '../server/src/query/overview.js';
import { encode, syntheticSession } from '../scripts/lib/synthetic.js';

const opts = { now: new Date('2026-10-28T12:00:00Z'), retentionDays: 30 };
const session = () =>
  syntheticSession({ start: Date.parse('2026-10-28T11:00:00Z'), installationId: 'demo-install-1', userId: 'demo-user-1' });

describe('decode and map', () => {
  it('protobuf spans keep ids, nanos, hierarchy and context', () => {
    const s = session();
    const spans = mapSpans(decodeTraces(encode('traces', s.traces), 'protobuf'), opts);
    expect(spans).toHaveLength(s.counts.spans);
    const action = spans.find((d) => d.name === 'confirmLogin' && d.outcome === 'failure')!;
    expect(action.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(action.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(action.parentSpanId).toBeNull();
    expect(action.statusCode).toBe(2);
    expect(action.sessionId).toBe(s.sessionId);
    // device.id never comes from the payload; the installation does.
    expect(action.deviceId).toBeNull();
    expect(action.installationId).toBe('demo-install-1');
    expect(action.outcomeReason).toBe('invalidPassword');
    expect(action.service).toBe('demo-shop');
    expect(action.platform).toBe('ios');
    expect(action.flow).toBe('login');
    expect(action.durationMs).toBeGreaterThan(600);
    const http = spans.find((d) => d.parentSpanId === action.spanId)!;
    expect(http.kind).toBe(3);
    expect(http._id).toBe(`demo-shop:${http.traceId}:${http.spanId}`);
    expect(action.expireAt.getTime() - opts.now.getTime()).toBe(30 * 86_400_000);
  });

  it('protobuf logs keep event name, trace link and journey fields', () => {
    const s = session();
    const events = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    expect(events).toHaveLength(s.counts.events);
    expect(events[0]!.eventName).toBe('session.start');
    expect(events[1]!.eventName).toBe('journey.screen.view');
    expect(events[1]!.screen).toBe('home');
    expect(events[1]!.screenLabel).toBe('Início');
    expect(events[1]!.traceId).toBeNull();
    // The id comes from log.record.uid, so resends map to the same document.
    expect(events.map((e) => e._id)).toEqual(s.uids.map((u) => `demo-shop:${u}`));
    const measured = events.find((e) => e.actionName === 'pay')!;
    expect(measured.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(measured.durationMs).toBeGreaterThan(900);
    expect(measured.outcome).toBe('success');
    expect(measured.userId).toBe('demo-user-1');
    // Same record, same id: identical resends are deduplicated.
    const again = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    expect(again.map((e) => e._id)).toEqual(events.map((e) => e._id));
  });

  it('documents are lean: what became a field is not kept twice', () => {
    const s = session();
    const events = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    const spans = mapSpans(decodeTraces(encode('traces', s.traces), 'protobuf'), opts);
    expect(events.every((e) => !('resource' in e))).toBe(true);
    const keys = (list: { key: string }[]) => list.map((a) => a.key);
    expect(keys(events.find((e) => e.actionName === 'chooseBiometric')!.attributes)).toEqual(['app.login.method']);
    // Not projected: kept.
    expect(keys(events[0]!.attributes)).toEqual([]);
    const action = spans.find((x) => x.name === 'confirmLogin')!;
    expect(keys(action.attributes)).toEqual(['journey.action.label', 'app.login.attempt']);
    expect(keys(action.resource)).toEqual([]);
    const http = spans.find((x) => x.parentSpanId === action.spanId)!;
    expect(keys(http.attributes)).toContain('http.request.method');
    expect(keys(http.attributes)).not.toContain('session.id');
    // The trace view puts the projected ones back.
    const shown = withContext(action);
    expect(shown.attributes.find((a) => a.key === 'journey.action.name')?.value).toBe('confirmLogin');
    expect(shown.attributes.find((a) => a.key === 'session.id')?.value).toBe(s.sessionId);
    expect(shown.resource.find((a) => a.key === 'service.name')?.value).toBe('demo-shop');
    expect(withContext(shown).attributes).toHaveLength(shown.attributes.length);
  });

  it('OTLP JSON (hex ids) decodes to the same documents', () => {
    const json = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1761649200000000000',
                  eventName: 'journey.screen.view',
                  traceId: '5B8EFFF798038103D269B633813FC60C',
                  spanId: 'EEE19B7EC3C1B174',
                  attributes: [
                    { key: 'session.id', value: { stringValue: 's1' } },
                    { key: 'journey.duration_ms', value: { intValue: '12' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [e] = mapLogs(decodeLogs(JSON.stringify(json), 'json'), opts);
    expect(e!.eventName).toBe('journey.screen.view');
    // No log.record.uid: a digest of the record is the id.
    expect(e!._id).toMatch(/^[0-9a-f]{40}$/);
    expect(e!.traceId).toBe('5b8efff798038103d269b633813fc60c');
    expect(e!.spanId).toBe('eee19b7ec3c1b174');
    expect(e!.durationMs).toBe(12);
    expect(e!.time.toISOString()).toBe('2025-10-28T11:00:00.000Z');
  });

  it('the receiver is the only source of deviceId and can override the user', () => {
    const s = session();
    const plain = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    expect(plain.every((e) => e.deviceId === null)).toBe(true);
    const events = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), {
      ...opts,
      identity: { deviceId: 'validated-device', userId: null },
    });
    expect(new Set(events.map((e) => e.deviceId))).toEqual(new Set(['validated-device']));
    expect(events.every((e) => e.userId === null)).toBe(true);
  });
});

describe('journey', () => {
  const build = (o: Partial<Parameters<typeof syntheticSession>[0]> = {}) => {
    const s = syntheticSession({ start: Date.parse('2026-10-28T11:00:00Z'), installationId: 'i', userId: 'u', ...o });
    const events = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    const spans = mapSpans(decodeTraces(encode('traces', s.traces), 'protobuf'), opts);
    return { view: buildJourney([...events].reverse(), spans.filter((x) => !x.parentSpanId)), spans };
  };

  it('orders steps and separates login attempts', () => {
    const { view } = build();
    expect(view.steps.map((s) => s.kind).slice(0, 5)).toEqual(['session', 'screen', 'screen', 'flowStart', 'action']);
    expect(view.steps[0]!.previousSessionId).toBeNull();
    const attempts = view.steps.filter((s) => s.code === 'confirmLogin');
    expect(attempts.map((a) => a.outcome)).toEqual(['failure', 'success']);
    expect(attempts.map((a) => a.outcomeReason)).toEqual(['invalidPassword', null]);
    expect(attempts.every((a) => a.measured && a.traceId)).toBe(true);
    expect(new Set(attempts.map((a) => a.actionInstanceId)).size).toBe(2);
    const method = view.steps.find((s) => s.code === 'chooseBiometric')!.extra;
    expect(method).toEqual([{ key: 'app.login.method', value: 'biometric' }]);
    expect(view.flows.map((f) => [f.code, f.status, f.attempt])).toEqual([
      ['login', 'success', 1],
      ['checkout', 'success', 1],
    ]);
    expect(view.flows[0]!.failures).toBe(1);
    expect(view.otherTraces).toEqual([]);
  });

  it('a failed flow keeps its reason; a session step links the previous one', () => {
    const { view } = build({ loginFails: true, previousSessionId: 'a'.repeat(32) });
    const login = view.flows.find((f) => f.code === 'login')!;
    expect([login.status, login.reason]).toEqual(['failure', 'blockedAccount']);
    expect(view.steps[0]!.previousSessionId).toBe('a'.repeat(32));
    // The session start is not a step of any flow.
    expect(login.steps).toBe(5);
  });

  it('a flow without an end is open, never abandoned', () => {
    const { view } = build({ checkoutOpen: true });
    expect(view.flows.find((f) => f.code === 'checkout')!.status).toBe('open');
  });

  it('traces with no journey step are listed apart', () => {
    const { view } = build();
    const extra = buildJourney(
      [],
      [{ traceId: 'f'.repeat(32), name: 'GET', start: new Date(), durationMs: 5, statusCode: 0, screen: null } as never],
    );
    expect(extra.otherTraces).toHaveLength(1);
    expect(view.steps.length).toBeGreaterThan(10);
  });
});

describe('trace', () => {
  it('builds depth-first rows and flags missing parents', () => {
    const s = session();
    const spans = mapSpans(decodeTraces(encode('traces', s.traces), 'protobuf'), opts);
    const traceId = spans[0]!.traceId;
    const own = spans.filter((x) => x.traceId === traceId);
    const view = buildTrace(traceId, own);
    expect(view.rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(view.rows[0]!.offsetMs).toBe(0);
    expect(view.missingParents).toBe(0);
    const orphan = buildTrace(traceId, own.slice(1));
    expect(orphan.missingParents).toBe(1);
    expect(orphan.rows[0]!.missingParent).toBe(true);
  });
});

describe('trusted identity headers', () => {
  it('replace device.id and user.id only when configured', async () => {
    const { headerIdentity } = await import('../server/src/http/ingest.js');
    const ctx = (h: Record<string, string>) => ({ req: { header: (k: string) => h[k.toLowerCase()] } }) as never;
    const base = { trustedDeviceHeader: null, trustedUserHeader: null } as never;
    expect(headerIdentity(base)(ctx({ 'x-device': 'd' }))).toBeUndefined();
    const cfg = { trustedDeviceHeader: 'x-device', trustedUserHeader: 'x-user' } as never;
    expect(headerIdentity(cfg)(ctx({ 'x-device': 'd1' }))).toEqual({ deviceId: 'd1', userId: null });
  });
});

describe('rollup helpers', () => {
  it('escape codes used as field names and read them back', () => {
    expect(escapeKey('System.Net.HttpRequestException')).toBe('System%2ENet%2EHttpRequestException');
    expect(escapeKey('$x%')).toBe('%24x%25');
    for (const k of ['invalidPassword', 'a.b$c%d', '503']) expect(unescapeKey(escapeKey(k))).toBe(k);
  });

  it('put durations in histogram buckets', () => {
    expect(durationBucket(0)).toBe(0);
    expect(durationBucket(50)).toBe(0);
    expect(durationBucket(51)).toBe(1);
    expect(durationBucket(980)).toBe(6);
    expect(durationBucket(10_000_000)).toBe(19);
  });
});

describe('overview', () => {
  it('estimates p95 from the histogram, and needs 20 values', () => {
    const hist = Array(20).fill(0);
    hist[0] = 100;
    expect(percentile(hist)).toBeCloseTo(47.5);
    hist[0] = 19;
    expect(percentile(hist)).toBeNull();
    const spread = Array(20).fill(0);
    spread[6] = 95; // up to 1 s
    spread[10] = 5; // 3 to 5 s
    expect(percentile(spread)).toBe(1000);
  });

  it('aligns periods to hours, and days to the reader time zone', () => {
    const now = new Date('2026-10-28T15:20:00Z');
    const day = periodWindow({ period: '24h', compare: 'previous', timeZone: 'UTC', now });
    expect([day.from.toISOString(), day.to.toISOString(), day.slots.length]).toEqual(['2026-10-27T16:00:00.000Z', '2026-10-28T16:00:00.000Z', 24]);
    expect(day.shift).toBe(86_400_000);
    expect(day.fraction).toBeCloseTo(1 / 3);
    expect(periodWindow({ period: '24h', compare: 'week', timeZone: 'UTC', now }).shift).toBe(7 * 86_400_000);
    const week = periodWindow({ period: '7d', compare: 'previous', timeZone: 'America/Sao_Paulo', now });
    expect(week.slots.map((d) => d.toISOString()).slice(-2)).toEqual(['2026-10-27T03:00:00.000Z', '2026-10-28T03:00:00.000Z']);
    expect(week.slots).toHaveLength(7);
  });

  const flow = (code: string, versions: [string, number, number, number, number][]): FlowStat => {
    const slots = 24;
    const byVersion = versions.map(([version, n, failure, nb, fb]) => ({
      version,
      platform: 'ios',
      started: n,
      failure,
      before: { n: nb, failure: fb },
      // The failures of the period all happen in its second half.
      series: {
        started: Array.from({ length: slots }, () => n / slots),
        failure: Array.from({ length: slots }, (_, i) => (i >= 12 ? failure / 12 : 0)),
      },
    }));
    const sum = (f: (v: (typeof byVersion)[number]) => number) => byVersion.reduce((a, v) => a + f(v), 0);
    return {
      code,
      label: null,
      started: sum((v) => v.started),
      success: 0,
      failure: sum((v) => v.failure),
      cancelled: 0,
      completed: 0,
      open: 0,
      p95Ms: null,
      before: { started: sum((v) => v.before.n), failure: sum((v) => v.before.failure), open: 0, p95Ms: null },
      series: {
        started: Array.from({ length: slots }, (_, i) => sum((v) => v.series.started[i]!)),
        failure: Array.from({ length: slots }, (_, i) => sum((v) => v.series.failure[i]!)),
        ended: Array(slots).fill(0),
      },
      reasons: [],
      byVersion,
    };
  };
  const slots = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 28, i)));
  const reason = (version: string, r: string, n: number) => ({ kind: 'flow', code: 'login', version, platform: 'ios', outcome: 'failure' as const, reason: r, errorType: null, n });

  it('finds a worse flow, the version behind it, the reason that grew and when it started', () => {
    const login = flow('login', [
      ['1.4.0', 1000, 160, 1000, 40],
      ['1.3.2', 1000, 40, 1000, 40],
    ]);
    const steady = flow('checkout', [['1.4.0', 1000, 30, 1000, 31]]);
    const changes = findChanges([login, steady], [], slots, {
      now: [reason('1.4.0', 'blockedAccount', 120), reason('1.4.0', 'invalidPassword', 40)],
      before: [reason('1.4.0', 'blockedAccount', 10), reason('1.4.0', 'invalidPassword', 30)],
    }, 200);
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    if (c.type !== 'failure') throw new Error('expected a failure change');
    expect([c.direction, c.code, c.where?.version]).toEqual(['worse', 'login', '1.4.0']);
    expect(c.where!.share).toBeCloseTo(1);
    expect(c.reason).toMatchObject({ reason: 'blockedAccount', beforeScope: 'version', shareBefore: 0.25, shareNow: 0.75 });
    expect(c.since).toBe('2026-10-28T12:00:00.000Z');
  });

  it('ignores small groups and noise, and reports slower actions', () => {
    const small = flow('login', [['1.4.0', 100, 16, 100, 4]]);
    const noise = flow('checkout', [['1.4.0', 1000, 44, 1000, 40]]);
    const action = (p95Ms: number, before: number) => ({ code: 'pay', label: 'Pagou', n: 1000, failure: 0, measured: 1000, p95Ms, before: { n: 1000, failure: 0, measured: 1000, p95Ms: before } });
    expect(findChanges([small, noise], [action(1100, 1000)], slots, { now: [], before: [] }, 200)).toEqual([]);
    const [slower] = findChanges([], [action(3400, 1900)], slots, { now: [], before: [] }, 200);
    expect(slower).toMatchObject({ type: 'duration', direction: 'worse', code: 'pay' });
  });
});

describe('inside an existing environment', () => {
  const withEnv = (env: Record<string, string>) => {
    const saved = process.env;
    // Vitest sets MODE=test.
    process.env = { MODE: 'all', ...env };
    try {
      return loadConfig();
    } finally {
      process.env = saved;
    }
  };

  it('reads the collection prefix, base path and trace link from the environment', () => {
    const c = withEnv({ COLLECTION_PREFIX: 'journey_', BASE_PATH: 'journey', TRACE_LINK_TEMPLATE: 'https://logs.example.com/?q=trace.id:{traceId}' });
    expect([c.collectionPrefix, c.basePath]).toEqual(['journey_', '/journey/']);
    expect(c.traceLink).toEqual({ template: 'https://logs.example.com/?q=trace.id:{traceId}', label: 'Abrir no log' });
    expect(withEnv({ TRACE_LINK_TEMPLATE: '/logs/{traceId}', TRACE_LINK_LABEL: 'Ver logs' }).traceLink!.label).toBe('Ver logs');

    const plain = withEnv({});
    expect([plain.collectionPrefix, plain.basePath, plain.traceLink]).toEqual(['', '/', null]);

    expect(() => withEnv({ COLLECTION_PREFIX: 'a$b' })).toThrow(/COLLECTION_PREFIX/);
    expect(() => withEnv({ TRACE_LINK_TEMPLATE: 'https://logs.example.com/' })).toThrow(/\{traceId\}/);
    expect(() => withEnv({ TRACE_LINK_TEMPLATE: 'javascript:alert({traceId})' })).toThrow(/http/);
  });

  it('normalizes the base path and refuses what is not a plain path', () => {
    expect(['', '/', 'journey', '/journey', '/journey/', 'tools//journey/'].map(normalizeBasePath)).toEqual([
      '/',
      '/',
      '/journey/',
      '/journey/',
      '/journey/',
      '/tools/journey/',
    ]);
    expect(() => normalizeBasePath('/a/../b')).toThrow(/BASE_PATH/);
    expect(() => normalizeBasePath('/"><script>')).toThrow(/BASE_PATH/);
  });

  it('builds the external trace link with the trace id encoded', () => {
    const template = 'https://logs.example.com/app/discover#/?query=trace.id:{traceId}&again={traceId}';
    expect(traceLinkUrl(template, '0af7651916cd43dd8448eb211c80319c')).toBe(
      'https://logs.example.com/app/discover#/?query=trace.id:0af7651916cd43dd8448eb211c80319c&again=0af7651916cd43dd8448eb211c80319c',
    );
    expect(traceLinkUrl(template, 'a b&c')).toContain('trace.id:a%20b%26c&');
  });

  it('takes several ids per filter, distinct, up to 50', () => {
    expect(idList(undefined)).toEqual([]);
    expect(idList(' demo-device-a, demo-device-b,,demo-device-a ')).toEqual(['demo-device-a', 'demo-device-b']);
    expect(idList(Array.from({ length: 50 }, (_, i) => `d${i}`).join(','))).toHaveLength(50);
    expect(idList(Array.from({ length: 51 }, (_, i) => `d${i}`).join(','))).toBeNull();
  });

  it('serves the UI, its assets and the API under the base path', async () => {
    const built = `<html><head><meta name="base-path" content="/" />
<script type="module" crossorigin src="./assets/index-1.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-1.css"></head><body><a href="#acoes"></a></body></html>`;
    expect(indexHtml(built, '/journey/')).toBe(built.replace('content="/"', 'content="/journey/"').replaceAll('"./assets/', '"/journey/assets/'));

    const webDir = mkdtempSync(path.join(tmpdir(), 'journey-web-'));
    try {
      mkdirSync(path.join(webDir, 'assets'));
      writeFileSync(path.join(webDir, 'index.html'), built);
      writeFileSync(path.join(webDir, 'assets', 'index-1.js'), 'console.log(1)');
      const config = {
        mode: 'query',
        basePath: '/journey/',
        apiToken: null,
        traceLink: { template: 'https://logs.example.com/{traceId}', label: 'Abrir no log' },
      } as Config;
      const app = dashboardRoutes({} as Store, config, webDir);

      const page = await app.request('/journey/sessions/abc?deviceId=a,b');
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<meta name="base-path" content="/journey/" />');
      expect(html).toContain('src="/journey/assets/index-1.js"');
      expect(await (await app.request('/journey/')).text()).toBe(html);
      expect(await (await app.request('/journey/assets/index-1.js')).text()).toBe('console.log(1)');
      expect(await (await app.request('/journey/api/config')).json()).toEqual({ traceLink: config.traceLink });

      const root = await app.request('/');
      expect([root.status, root.headers.get('location')]).toEqual([302, '/journey/']);
      expect((await app.request('/health')).status).toBe(200);
      expect((await app.request('/api/config')).status).toBe(404);
      expect((await app.request('/assets/index-1.js')).status).toBe(404);

      // Default: everything at the root, as before.
      const plain = dashboardRoutes({} as Store, { ...config, basePath: '/', traceLink: null }, webDir);
      expect(await (await plain.request('/sessions')).text()).toContain('src="/assets/index-1.js"');
      expect(await (await plain.request('/assets/index-1.js')).text()).toBe('console.log(1)');
      expect(await (await plain.request('/api/config')).json()).toEqual({ traceLink: null });
    } finally {
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});
