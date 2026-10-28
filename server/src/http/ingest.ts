// OTLP/HTTP receiver: POST /v1/traces and /v1/logs, protobuf or JSON.
import { gunzipSync } from 'node:zlib';
import { Hono, type Context } from 'hono';
import type { Config } from '../config.js';
import { mapLogs, mapSpans, type IngestIdentity } from '../ingest/mapping.js';
import { countItems, decodeLogs, decodeTraces, successBody } from '../otlp/decode.js';
import { writeEvents, writeSpans, type Store } from '../store/mongo.js';

/**
 * Extension point: what the receiver authenticated about the sender. The
 * default trusts the payload. A production receiver (for example a BFF)
 * returns the device and user it validated, and they replace the payload's.
 */
export type IdentityResolver = (c: Context) => IngestIdentity | undefined;

/** Default resolver: the trusted headers of [config], when configured. */
export function headerIdentity(config: Config): IdentityResolver {
  return (c) => {
    if (!config.trustedDeviceHeader && !config.trustedUserHeader) return undefined;
    const read = (h: string | null) => (h ? (c.req.header(h)?.trim() || null) : undefined);
    return { deviceId: read(config.trustedDeviceHeader), userId: read(config.trustedUserHeader) };
  };
}

export function ingestRoutes(store: Store, config: Config, resolveIdentity: IdentityResolver = headerIdentity(config)) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'content-type, authorization');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (config.ingestToken && c.req.header('authorization') !== `Bearer ${config.ingestToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  const handle = (signal: 'traces' | 'logs') => async (c: Context) => {
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const encoding =
      type === 'application/x-protobuf' || type === 'application/protobuf'
        ? 'protobuf'
        : type === 'application/json'
          ? 'json'
          : null;
    if (!encoding) return c.json({ error: 'unsupported content-type' }, 415);
    const contentEncoding = (c.req.header('content-encoding') ?? 'identity').toLowerCase();
    if (contentEncoding !== 'identity' && contentEncoding !== 'gzip') {
      return c.json({ error: 'unsupported content-encoding' }, 415);
    }

    let buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.byteLength > config.maxBodyBytes) return c.json({ error: 'body too large' }, 413);
    if (contentEncoding === 'gzip') {
      try {
        buf = new Uint8Array(gunzipSync(buf, { maxOutputLength: config.maxBodyBytes * 8 }));
      } catch {
        return c.json({ error: 'malformed gzip body' }, 400);
      }
    }

    let groups;
    try {
      groups = signal === 'traces' ? decodeTraces(buf, encoding) : decodeLogs(buf, encoding);
    } catch {
      return c.json({ error: 'malformed OTLP request' }, 400);
    }
    if (countItems(groups) > config.maxRecordsPerRequest) return c.json({ error: 'too many records' }, 413);

    const opts = { now: new Date(), retentionDays: config.retentionDays, identity: resolveIdentity(c) };
    try {
      if (signal === 'traces') await writeSpans(store, mapSpans(groups as never, opts));
      else await writeEvents(store, mapLogs(groups as never, opts));
    } catch {
      // OTLP: 503 tells the sender to retry later.
      return c.json({ error: 'storage unavailable' }, 503);
    }
    const body = successBody(signal, encoding);
    if (encoding === 'json') return c.body(body as string, 200, { 'content-type': 'application/json' });
    return c.body(body as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'application/x-protobuf' });
  };

  app.post('/v1/traces', handle('traces'));
  app.post('/v1/logs', handle('logs'));
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
