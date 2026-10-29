// Configuration from environment variables. See README "Configuration".

export type Mode = 'all' | 'ingest' | 'query';

export interface Config {
  mode: Mode;
  mongoUrl: string;
  mongoDb: string;
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
  maxBodyBytes: number;
  maxRecordsPerRequest: number;
  /** When set, `/api` requires `Authorization: Bearer <token>`. */
  apiToken: string | null;
  /** When set, ingestion requires `Authorization: Bearer <token>`. */
  ingestToken: string | null;
  /**
   * Headers set by a trusted proxy in front of the receiver (for example a
   * BFF) with the device and user it authenticated. The device header is
   * the only source of `deviceId`; the user header replaces `user.id` from
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

export function loadConfig(): Config {
  const mode = (process.env.MODE ?? 'all') as Mode;
  if (!['all', 'ingest', 'query'].includes(mode)) throw new Error(`MODE must be all, ingest or query (got ${mode})`);
  return {
    mode,
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'otel_journey',
    otlpPort: int('OTLP_PORT', 4318),
    httpPort: int('PORT', 8686),
    host: process.env.HOST ?? '0.0.0.0',
    retentionDays: int('RETENTION_DAYS', 30),
    aggregator: (process.env.AGGREGATOR ?? 'on').toLowerCase() !== 'off',
    aggregateEveryMs: int('AGGREGATE_EVERY_SECONDS', 15) * 1000,
    aggregateLagMs: int('AGGREGATE_LAG_SECONDS', 30) * 1000,
    rollupRetentionDays: int('ROLLUP_RETENTION_DAYS', 400),
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
