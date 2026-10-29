// Configuration from environment variables. See README "Configuration".

export type Mode = 'all' | 'ingest' | 'query';

export interface Config {
  mode: Mode;
  mongoUrl: string;
  mongoDb: string;
  /** Prepended to every collection name (`journey_spans`), to share a database. */
  collectionPrefix: string;
  /** Where the UI and `/api` are served, for a reverse proxy: `/`, or `/journey/` (always ends with `/`). */
  basePath: string;
  /** Link from a trace to the log tool the environment already uses; null when not set. */
  traceLink: { template: string; label: string } | null;
  /** OTLP/HTTP receiver port (`/v1/traces`, `/v1/logs`). */
  otlpPort: number;
  /** Dashboard and query API port. */
  httpPort: number;
  host: string;
  /** TTL of `spans`, `events` and `sessions`. */
  retentionDays: number;
  /** Whether this instance derives `sessions` and `rollups` (modes `all` and `query`). */
  aggregator: boolean;
  aggregateEveryMs: number;
  /** Records received in the last N ms wait for the next run (slow inserts, writer clocks). */
  aggregateLagMs: number;
  /** TTL of `rollups`: the overview can look this far back. */
  rollupRetentionDays: number;
  /** Smallest group the overview compares (flow runs, measured actions). */
  overviewMinVolume: number;
  maxBodyBytes: number;
  maxRecordsPerRequest: number;
  /** When set, `/api` requires `Authorization: Bearer <token>`. */
  apiToken: string | null;
  /** When set, ingestion requires `Authorization: Bearer <token>`. */
  ingestToken: string | null;
  /**
   * Headers set by a trusted proxy in front of the receiver (for example a
   * BFF) with the device and user it authenticated. The device header is
   * the only source of `deviceId`; the user header replaces `user.id` on the
   * records that carry one (never on events from before the login) from
   * the payload. Only set these when the receiver is not reachable without
   * that proxy.
   */
  trustedDeviceHeader: string | null;
  trustedUserHeader: string | null;
  /** Maximum query window, in days. */
  maxWindowDays: number;
  maxPageSize: number;
  maxJourneyEvents: number;
  maxTraceSpans: number;
}

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** `journey`, `/journey` and `/journey/` are all `/journey/`; empty is `/`. */
export function normalizeBasePath(value: string | undefined): string {
  const segments = (value ?? '').split('/').filter(Boolean);
  if (segments.some((s) => !/^[A-Za-z0-9._~-]+$/.test(s) || s === '.' || s === '..')) {
    throw new Error(`BASE_PATH must be a plain path such as /journey/ (got ${value})`);
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

function collectionPrefix(value: string | undefined): string {
  if (value && !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`COLLECTION_PREFIX may only use letters, digits, _, . and - (got ${value})`);
  }
  return value ?? '';
}

function traceLink(value: string | undefined, label: string | undefined): Config['traceLink'] {
  const template = value?.trim();
  if (!template) return null;
  if (!template.includes('{traceId}')) throw new Error('TRACE_LINK_TEMPLATE must contain {traceId}');
  if (!/^(https?:\/\/|\/)/i.test(template)) throw new Error('TRACE_LINK_TEMPLATE must be an http(s) URL or a path');
  return { template, label: label?.trim() || 'Abrir no log' };
}

export function loadConfig(): Config {
  const mode = (process.env.MODE ?? 'all') as Mode;
  if (!['all', 'ingest', 'query'].includes(mode)) throw new Error(`MODE must be all, ingest or query (got ${mode})`);
  return {
    mode,
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'otel_journey',
    collectionPrefix: collectionPrefix(process.env.COLLECTION_PREFIX),
    basePath: normalizeBasePath(process.env.BASE_PATH),
    traceLink: traceLink(process.env.TRACE_LINK_TEMPLATE, process.env.TRACE_LINK_LABEL),
    otlpPort: int('OTLP_PORT', 4318),
    httpPort: int('PORT', 8686),
    host: process.env.HOST ?? '0.0.0.0',
    retentionDays: int('RETENTION_DAYS', 30),
    aggregator: (process.env.AGGREGATOR ?? 'on').toLowerCase() !== 'off',
    aggregateEveryMs: int('AGGREGATE_EVERY_SECONDS', 15) * 1000,
    aggregateLagMs: int('AGGREGATE_LAG_SECONDS', 30) * 1000,
    rollupRetentionDays: int('ROLLUP_RETENTION_DAYS', 400),
    overviewMinVolume: int('OVERVIEW_MIN_VOLUME', 200),
    maxBodyBytes: int('MAX_BODY_BYTES', 1024 * 1024),
    maxRecordsPerRequest: int('MAX_RECORDS_PER_REQUEST', 1000),
    apiToken: process.env.API_TOKEN || null,
    ingestToken: process.env.INGEST_TOKEN || null,
    trustedDeviceHeader: process.env.TRUSTED_DEVICE_HEADER?.toLowerCase() || null,
    trustedUserHeader: process.env.TRUSTED_USER_HEADER?.toLowerCase() || null,
    maxWindowDays: int('MAX_WINDOW_DAYS', 31),
    maxPageSize: int('MAX_PAGE_SIZE', 200),
    maxJourneyEvents: int('MAX_JOURNEY_EVENTS', 5000),
    maxTraceSpans: int('MAX_TRACE_SPANS', 2000),
  };
}
