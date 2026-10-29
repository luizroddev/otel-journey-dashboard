import { describe, expect, it } from 'vitest';
import { mapLogs, mapSpans } from '../server/src/ingest/mapping.js';
import { decodeLogs, decodeTraces } from '../server/src/otlp/decode.js';
import { buildJourney } from '../server/src/query/journey.js';
import { buildTrace } from '../server/src/query/trace.js';
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
    for (const e of events) {
      const uid = e.attributes.find((a) => a.key === 'log.record.uid')!.value;
      expect(e._id).toBe(`demo-shop:${uid}`);
    }
    const measured = events.find((e) => e.actionName === 'pay')!;
    expect(measured.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(measured.durationMs).toBeGreaterThan(900);
    expect(measured.outcome).toBe('success');
    expect(measured.userId).toBe('demo-user-1');
    // Same record, same id: identical resends are deduplicated.
    const again = mapLogs(decodeLogs(encode('logs', s.logs), 'protobuf'), opts);
    expect(again.map((e) => e._id)).toEqual(events.map((e) => e._id));
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
