// MongoDB storage: the collections, their indexes, inserts from ingestion
// and reads for the query API. Writers only insert `spans` and `events`;
// `sessions` and `rollups` are derived by the aggregator (aggregate.ts).
import { MongoClient, type Collection, type Db, type Filter, type AnyBulkWriteOperation } from 'mongodb';
import type { EventDoc, JobDoc, RollupDoc, SessionDoc, SpanDoc } from '../model.js';

export interface Store {
  db: Db;
  spans: Collection<SpanDoc>;
  events: Collection<EventDoc>;
  sessions: Collection<SessionDoc>;
  rollups: Collection<RollupDoc>;
  jobs: Collection<JobDoc>;
  close(): Promise<void>;
}

/** [prefix] goes before every collection name (`journey_spans`), so the dashboard can share a database. */
export async function connect(url: string, dbName: string, prefix = ''): Promise<Store> {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  return {
    db,
    spans: db.collection<SpanDoc>(`${prefix}spans`),
    events: db.collection<EventDoc>(`${prefix}events`),
    sessions: db.collection<SessionDoc>(`${prefix}sessions`),
    rollups: db.collection<RollupDoc>(`${prefix}rollups`),
    jobs: db.collection<JobDoc>(`${prefix}jobs`),
    close: () => client.close(),
  };
}

/**
 * Creates the indexes of docs/storage-schema.md. Idempotent. `raw`: the
 * collections writers fill (`spans`, `events`); `derived`: the ones the
 * aggregator fills.
 */
export async function ensureIndexes(s: Store, which: { raw: boolean; derived: boolean }): Promise<void> {
  const all: Promise<unknown>[] = [];
  if (which.raw) {
    all.push(
      s.spans.createIndexes([
        { key: { traceId: 1, start: 1 } },
        { key: { sessionId: 1, start: 1 } },
        { key: { receivedAt: 1 } },
        { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      ]),
      s.events.createIndexes([
        { key: { sessionId: 1, time: 1 } },
        { key: { traceId: 1 } },
        { key: { receivedAt: 1 } },
        { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      ]),
    );
  }
  if (which.derived) {
    all.push(
      s.sessions.createIndexes([
        { key: { lastSeen: -1 } },
        { key: { deviceId: 1, lastSeen: -1 } },
        { key: { installationId: 1, lastSeen: -1 } },
        { key: { userIds: 1, lastSeen: -1 } },
        { key: { 'failures.code': 1, lastSeen: -1 } },
        { key: { flows: 1, lastSeen: -1 } },
        { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      ]),
      s.rollups.createIndexes([
        { key: { kind: 1, hour: 1 } },
        { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      ]),
    );
  }
  await Promise.all(all);
}

/** Inserts documents whose `_id` is new; resends are ignored. Returns how many were new. */
async function insertNew<T extends { _id: string }>(col: Collection<T>, docs: T[]): Promise<number> {
  if (docs.length === 0) return 0;
  const ops = docs.map(
    (d) =>
      ({
        updateOne: { filter: { _id: d._id }, update: { $setOnInsert: d }, upsert: true },
      }) as unknown as AnyBulkWriteOperation<T>,
  );
  const r = await col.bulkWrite(ops, { ordered: false });
  return r.upsertedCount;
}

export const writeSpans = (s: Store, docs: SpanDoc[]) => insertNew(s.spans, docs);
export const writeEvents = (s: Store, docs: EventDoc[]) => insertNew(s.events, docs);

export interface SessionQuery {
  from: Date;
  to: Date;
  /** Any of these devices, installations or users (a person with several devices). */
  deviceIds?: string[];
  installationIds?: string[];
  userIds?: string[];
  sessionId?: string;
  service?: string;
  version?: string;
  platform?: string;
  environment?: string;
  onlyErrors?: boolean;
  /** Sessions that started this flow. */
  flow?: string;
  /** Sessions where this flow run or action failed, optionally with this reason or error type. */
  failed?: { kind: 'flow' | 'action'; code: string; reason?: string; errorType?: string };
  limit: number;
  /** Cursor: sessions seen before this instant. */
  before?: Date;
}

export async function listSessions(s: Store, q: SessionQuery): Promise<SessionDoc[]> {
  const f: Filter<SessionDoc> = {
    lastSeen: { $gte: q.from, $lte: q.to, ...(q.before ? { $lt: q.before } : {}) },
    expireAt: { $gt: new Date() },
  };
  if (q.sessionId) f._id = q.sessionId;
  if (q.deviceIds?.length) f.deviceId = { $in: q.deviceIds };
  if (q.installationIds?.length) f.installationId = { $in: q.installationIds };
  if (q.userIds?.length) f.userIds = { $in: q.userIds };
  if (q.service) f.services = q.service;
  if (q.version) f.versions = q.version;
  if (q.platform) f.platforms = q.platform;
  if (q.environment) f.environments = q.environment;
  if (q.onlyErrors) f.errorCount = { $gt: 0 };
  if (q.flow) f.flows = q.flow;
  if (q.failed) {
    const { kind, code, reason, errorType } = q.failed;
    f.failures = { $elemMatch: { kind, code, ...(reason ? { reason } : {}), ...(errorType ? { errorType } : {}) } };
  }
  return s.sessions.find(f).sort({ lastSeen: -1 }).limit(q.limit).toArray();
}

export async function getSession(s: Store, id: string): Promise<SessionDoc | null> {
  return s.sessions.findOne({ _id: id, expireAt: { $gt: new Date() } });
}

export async function sessionEvents(s: Store, sessionId: string, limit: number): Promise<EventDoc[]> {
  return s.events
    .find({ sessionId, expireAt: { $gt: new Date() } })
    .sort({ time: 1, timeNs: 1 })
    .limit(limit)
    .toArray();
}

/** Root spans of a session (no parent, or a parent outside the session). */
export async function sessionRootSpans(s: Store, sessionId: string, limit: number): Promise<SpanDoc[]> {
  return s.spans
    .find({ sessionId, parentSpanId: null, expireAt: { $gt: new Date() } })
    .project<SpanDoc>({ attributes: 0, events: 0, resource: 0 })
    .sort({ start: 1 })
    .limit(limit)
    .toArray();
}

export async function traceSpans(s: Store, traceId: string, limit: number): Promise<SpanDoc[]> {
  return s.spans
    .find({ traceId, expireAt: { $gt: new Date() } })
    .sort({ start: 1, startNs: 1 })
    .limit(limit)
    .toArray();
}

export async function traceEvents(s: Store, traceId: string, limit: number): Promise<EventDoc[]> {
  return s.events
    .find({ traceId, expireAt: { $gt: new Date() } })
    .sort({ time: 1 })
    .limit(limit)
    .toArray();
}

/** Values seen in the window, for filter dropdowns. Reads the hourly rollups. */
export async function facets(s: Store, from: Date, to: Date) {
  const hour = { $gte: new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000), $lte: to };
  const values = async (field: 'service' | 'version' | 'platform' | 'environment', extra: Filter<RollupDoc> = {}) =>
    ((await s.rollups.distinct(field, { hour, ...extra })) as (string | null)[]).filter((v): v is string => !!v).sort();
  const [services, versions, platforms, environments, flows] = await Promise.all([
    values('service'),
    values('version'),
    values('platform'),
    values('environment'),
    s.rollups.distinct('code', { hour, kind: 'flow' }),
  ]);
  return { services, versions, platforms, environments, flows: flows.sort() };
}
