// Synthetic OTLP data shaped like what otel_flutter_bridge sends (journey
// contract version 2, see its docs/specs/journey.md): a fictional shop where
// login fails once, the retry works, then a purchase. No real app, user or
// device is involved.
import { randomBytes } from 'node:crypto';
import { otlpTypes } from '../../server/src/otlp/decode.js';

type V = string | number | boolean;
type KV = { key: string; value: Record<string, unknown> };

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const kv = (key: string, value: V): KV => ({
  key,
  value:
    typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value },
});
const attrs = (o: Record<string, V | null | undefined>): KV[] =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => kv(k, v as V));
const ns = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

export interface SyntheticOptions {
  /** Start of the session, ms since epoch. */
  start: number;
  /** `app.installation.id` of the fictional app. */
  installationId: string;
  userId: string;
  sessionId?: string;
  /** Session this one follows (`session.previous_id` on `session.start`). */
  previousSessionId?: string;
  platform?: 'ios' | 'android';
  version?: string;
  /** Whether the login retry also fails (the session never logs in). */
  loginFails?: boolean;
  /** Whether the payment fails. */
  paymentFails?: boolean;
  /** Leave the checkout flow without an end (no conclusion). */
  checkoutOpen?: boolean;
}

export interface SyntheticSession {
  sessionId: string;
  traces: Record<string, unknown>;
  logs: Record<string, unknown>;
  counts: { spans: number; events: number };
  /** `log.record.uid` of each record, in order. */
  uids: string[];
}

/** Builds one session as OTLP request objects (protobufjs `fromObject` shape). */
export function syntheticSession(o: SyntheticOptions): SyntheticSession {
  const sessionId = o.sessionId ?? hex(16);
  const platform = o.platform ?? 'ios';
  const resource = {
    attributes: attrs({
      'service.name': 'demo-shop',
      'service.version': o.version ?? '1.4.0',
      'deployment.environment.name': 'local',
      'os.name': platform,
      'os.type': platform === 'ios' ? 'darwin' : 'linux',
      'app.installation.id': o.installationId,
    }),
  };
  const spans: Record<string, unknown>[] = [];
  const records: Record<string, unknown>[] = [];
  let t = o.start;
  let screen: string | null = null;
  let flow: { name: string; id: string } | null = null;
  let user: string | null = null;

  const ctx = () => ({
    'session.id': sessionId,
    'user.id': user,
    'app.screen.name': screen,
    'journey.flow.name': flow?.name,
    'journey.flow.instance_id': flow?.id,
    'otel_flutter_bridge.source': 'dart',
  });
  const uids: string[] = [];
  const event = (name: string, extra: Record<string, V | null | undefined>, at = t, trace?: { traceId: string; spanId: string }) => {
    const uid = hex(16);
    uids.push(uid);
    records.push({
      timeUnixNano: ns(at),
      observedTimeUnixNano: ns(at + 5),
      severityNumber: 9,
      severityText: 'INFO',
      attributes: attrs({ 'event.name': name, 'log.record.uid': uid, ...ctx(), ...extra }),
      ...(trace
        ? { traceId: Buffer.from(trace.traceId, 'hex'), spanId: Buffer.from(trace.spanId, 'hex'), flags: 1 }
        : {}),
    });
  };
  const showScreen = (code: string, label: string) => {
    screen = code;
    event('journey.screen.view', { 'journey.screen.label': label });
    t += 1200;
  };
  const startFlow = (name: string, label: string) => {
    flow = { name, id: hex(16) };
    event('journey.flow.start', { 'journey.flow.label': label });
    const run = { ...flow, label, start: t };
    t += 200;
    return run;
  };
  const endFlow = (f: { name: string; id: string; label: string; start: number }, outcome: string, reason?: string) => {
    event('journey.flow.end', {
      'journey.flow.name': f.name,
      'journey.flow.label': f.label,
      'journey.flow.instance_id': f.id,
      'journey.outcome': outcome,
      'journey.outcome_reason': reason,
      'journey.duration_ms': Math.round(t - f.start),
    });
    flow = null;
    t += 300;
  };
  const instant = (code: string, label: string, extra: Record<string, V> = {}) => {
    event('journey.action', { 'journey.action.name': code, 'journey.action.label': label, 'journey.action.instance_id': hex(16), ...extra });
    t += 900;
  };
  const track = (
    code: string,
    label: string,
    http: { method: string; route: string; status: number; ms: number },
    outcome: 'success' | 'failure',
    extra: Record<string, V> = {},
    reason?: string,
  ) => {
    const traceId = hex(16);
    const spanId = hex(8);
    const actionId = hex(16);
    const start = t;
    const httpStart = start + 15;
    const httpEnd = httpStart + http.ms;
    const end = httpEnd + 20;
    const base = { ...ctx(), 'journey.action.name': code, 'journey.action.label': label, 'journey.action.instance_id': actionId };
    const failed = outcome === 'failure';
    spans.push({
      traceId: Buffer.from(traceId, 'hex'),
      spanId: Buffer.from(spanId, 'hex'),
      name: code,
      kind: 1,
      startTimeUnixNano: ns(start),
      endTimeUnixNano: ns(end),
      attributes: attrs({ ...base, ...extra, 'journey.outcome': outcome, 'journey.outcome_reason': reason }),
      status: failed ? { code: 2, message: 'failure' } : {},
    });
    const httpSpanId = hex(8);
    spans.push({
      traceId: Buffer.from(traceId, 'hex'),
      spanId: Buffer.from(httpSpanId, 'hex'),
      parentSpanId: Buffer.from(spanId, 'hex'),
      name: http.method,
      kind: 3,
      startTimeUnixNano: ns(httpStart),
      endTimeUnixNano: ns(httpEnd),
      attributes: attrs({
        ...ctx(),
        'http.request.method': http.method,
        'http.response.status_code': http.status,
        'url.scheme': 'https',
        'server.address': 'api.demo-shop.example',
        'url.path': http.route,
        ...(http.status >= 400 ? { 'error.type': String(http.status) } : {}),
      }),
      status: http.status >= 400 ? { code: 2, message: String(http.status) } : {},
    });
    // The backend continues the trace (server span), as in a real setup.
    spans.push({
      traceId: Buffer.from(traceId, 'hex'),
      spanId: Buffer.from(hex(8), 'hex'),
      parentSpanId: Buffer.from(httpSpanId, 'hex'),
      name: `${http.method} ${http.route}`,
      kind: 2,
      startTimeUnixNano: ns(httpStart + 8),
      endTimeUnixNano: ns(httpEnd - 6),
      attributes: attrs({ 'http.request.method': http.method, 'http.route': http.route, 'http.response.status_code': http.status }),
      status: http.status >= 500 ? { code: 2 } : {},
    });
    event(
      'journey.action',
      {
        ...base,
        ...extra,
        'journey.outcome': outcome,
        'journey.outcome_reason': reason,
        'journey.duration_ms': Math.round(end - start),
        ...(failed && http.status >= 400 ? { 'error.type': String(http.status) } : {}),
      },
      start,
      { traceId, spanId },
    );
    t = end + 700;
  };

  event('session.start', { 'session.previous_id': o.previousSessionId });
  showScreen('home', 'Início');
  showScreen('login', 'Login');
  const login = startFlow('login', 'Login');
  instant('chooseSavedLogin', 'Escolheu login salvo');
  instant('chooseBiometric', 'Escolheu biometria', { 'app.login.method': 'biometric' });
  track(
    'confirmLogin',
    'Confirmou o login',
    { method: 'POST', route: '/v1/sessions', status: 401, ms: 640 },
    'failure',
    { 'app.login.attempt': 1 },
    'invalidPassword',
  );
  instant('retry', 'Tentou novamente');
  const loginOk = !o.loginFails;
  track(
    'confirmLogin',
    'Confirmou o login',
    { method: 'POST', route: '/v1/sessions', status: loginOk ? 200 : 401, ms: 410 },
    loginOk ? 'success' : 'failure',
    { 'app.login.attempt': 2 },
    loginOk ? undefined : 'blockedAccount',
  );
  endFlow(login, loginOk ? 'success' : 'failure', loginOk ? undefined : 'blockedAccount');

  if (loginOk) {
    user = o.userId;
    showScreen('catalog', 'Catálogo');
    const checkout = startFlow('checkout', 'Compra');
    instant('addToCart', 'Adicionou ao carrinho', { 'app.cart.items': 2 });
    showScreen('cart', 'Carrinho');
    const payOk = !o.paymentFails;
    track(
      'pay',
      'Pagou',
      { method: 'POST', route: '/v1/payments', status: payOk ? 201 : 502, ms: payOk ? 980 : 3100 },
      payOk ? 'success' : 'failure',
      {},
      payOk ? undefined : 'paymentUnavailable',
    );
    if (!o.checkoutOpen) endFlow(checkout, payOk ? 'success' : 'failure', payOk ? undefined : 'paymentUnavailable');
  }

  return {
    sessionId,
    traces: {
      resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'otel_flutter_bridge', version: '0.1.0' }, spans }] }],
    },
    logs: {
      resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'otel_flutter_bridge.journey' }, logRecords: records }] }],
    },
    counts: { spans: spans.length, events: records.length },
    uids,
  };
}

/** Encodes a request object as OTLP protobuf. */
export function encode(signal: 'traces' | 'logs', request: Record<string, unknown>): Uint8Array {
  const t = signal === 'traces' ? otlpTypes().traces : otlpTypes().logs;
  return t.encode(t.fromObject(request)).finish();
}
