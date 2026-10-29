// MongoDB storage: collections `spans`, `events` and `sessions`, their
// indexes, writes from ingestion and reads for the query API.
import { MongoClient, type Collection, type Db, type Filter, type AnyBulkWriteOperation } from 'mongodb';
import type { EventDoc, SessionDoc, SpanDoc } from '../model.js';

export interface Store {
  db: Db;
  spans: Collection<SpanDoc>;
  events: Collection<EventDoc>;
  sessions: Collection<SessionDoc>;
  close(): Promise<void>;
}

export async function connect(url: string, dbName: string): Promise<Store> {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  return {
    db,
    spans: db.collection<SpanDoc>('spans'),
    events: db.collection<EventDoc>('events'),
    sessions: db.collection<SessionDoc>('sessions'),
    close: () => client.close(),
  };
}

/** Creates the indexes of docs/storage-schema.md. Idempotent. */
export async function ensureIndexes(s: Store): Promise<void> {
  await Promise.all([
    s.spans.createIndexes([
      { key: { traceId: 1, start: 1 } },
      { key: { sessionId: 1, start: 1 } },
      { key: { statusCode: 1, start: -1 } },
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
    ]),
    s.events.createIndexes([
      { key: { sessionId: 1, time: 1 } },
      { key: { deviceId: 1, time: -1 } },
      { key: { userId: 1, time: -1 } },
      { key: { traceId: 1 } },
      { key: { outcome: 1, time: -1 } },
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
    ]),
    s.sessions.createIndexes([
      { key: { lastSeen: -1 } },
      { key: { deviceId: 1, lastSeen: -1 } },
      { key: { userIds: 1, lastSeen: -1 } },
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
    ]),
  ]);
}

/** Inserts documents whose `_id` is new; resends are ignored. Returns the inserted ones. */
async function insertNew<T extends { _id: string }>(col: Collection<T>, docs: T[]): Promise<T[]> {
  if (docs.length === 0) return [];
  const ops = docs.map(
    (d) =>
      ({
        updateOne: { filter: { _id: d._id }, update: { $setOnInsert: d }, upsert: true },
      }) as unknown as AnyBulkWriteOperation<T>,
  );
  const r = await col.bulkWrite(ops, { ordered: false });
  return Object.keys(r.upsertedIds).map((i) => docs[Number(i)]!);
}

export async function writeSpans(s: Store, docs: SpanDoc[]): Promise<number> {
  const inserted = await insertNew(s.spans, docs);
  await updateSessions(s, inserted.map((d) => ({
    sessionId: d.sessionId,
    deviceId: d.deviceId,
    userId: d.userId,
    service: d.service,
    version: d.serviceVersion,
    platform: d.platform,
    environment: d.environment,
    time: d.start,
    end: d.end,
    spans: 1,
    events: 0,
    // One error per failed operation: action spans count through their
    // event, child spans through their root.
    errors: d.statusCode === 2 && !d.actionInstanceId && !d.parentSpanId ? 1 : 0,
    expireAt: d.expireAt,
  })));
  return inserted.length;
}

export async function writeEvents(s: Store, docs: EventDoc[]): Promise<number> {
  const inserted = await insertNew(s.events, docs);
  await updateSessions(s, inserted.map((d) => ({
    sessionId: d.sessionId,
    deviceId: d.deviceId,
    userId: d.userId,
    service: d.service,
    version: d.serviceVersion,
    platform: d.platform,
    environment: d.environment,
    time: d.time,
    end: d.time,
    spans: 0,
    events: 1,
    errors: d.outcome === 'failure' ? 1 : 0,
    expireAt: d.expireAt,
  })));
  return inserted.length;
}

interface SessionTouch {
  sessionId: string | null;
  deviceId: string | null;
  userId: string | null;
  service: string | null;
  version: string | null;
  platform: string | null;
  environment: string | null;
  time: Date;
  end: Date;
  spans: number;
  events: number;
  errors: number;
  expireAt: Date;
}

async function updateSessions(s: Store, touches: SessionTouch[]): Promise<void> {
  const by = new Map<string, SessionTouch[]>();
  for (const t of touches) {
    if (!t.sessionId) continue;
    by.set(t.sessionId, [...(by.get(t.sessionId) ?? []), t]);
  }
  if (by.size === 0) return;
  const ops: AnyBulkWriteOperation<SessionDoc>[] = [];
  for (const [id, list] of by) {
    const values = (f: (t: SessionTouch) => string | null) =>
      [...new Set(list.map(f).filter((v): v is string => !!v))];
    const first = new Date(Math.min(...list.map((t) => t.time.getTime())));
    const last = new Date(Math.max(...list.map((t) => t.end.getTime())));
    const device = list.find((t) => t.deviceId)?.deviceId ?? null;
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $min: { firstSeen: first },
          $max: { lastSeen: last, expireAt: new Date(Math.max(...list.map((t) => t.expireAt.getTime()))) },
          $inc: {
            spanCount: list.reduce((n, t) => n + t.spans, 0),
            eventCount: list.reduce((n, t) => n + t.events, 0),
            errorCount: list.reduce((n, t) => n + t.errors, 0),
          },
          $addToSet: {
            userIds: { $each: values((t) => t.userId) },
            services: { $each: values((t) => t.service) },
            versions: { $each: values((t) => t.version) },
            platforms: { $each: values((t) => t.platform) },
            environments: { $each: values((t) => t.environment) },
          },
          ...(device ? { $set: { deviceId: device } } : { $setOnInsert: { deviceId: null } }),
        },
        upsert: true,
      },
    });
  }
  await s.sessions.bulkWrite(ops, { ordered: false });
}

export interface SessionQuery {
  from: Date;
  to: Date;
  deviceId?: string;
  userId?: string;
  sessionId?: string;
  service?: string;
  version?: string;
  platform?: string;
  environment?: string;
  onlyErrors?: boolean;
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
  if (q.deviceId) f.deviceId = q.deviceId;
  if (q.userId) f.userIds = q.userId;
  if (q.service) f.services = q.service;
  if (q.version) f.versions = q.version;
  if (q.platform) f.platforms = q.platform;
  if (q.environment) f.environments = q.environment;
  if (q.onlyErrors) f.errorCount = { $gt: 0 };
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

export async function facets(s: Store, from: Date, to: Date) {
  const f = { lastSeen: { $gte: from, $lte: to } };
  const [services, versions, platforms, environments] = await Promise.all([
    s.sessions.distinct('services', f),
    s.sessions.distinct('versions', f),
    s.sessions.distinct('platforms', f),
    s.sessions.distinct('environments', f),
  ]);
  return { services, versions, platforms, environments };
}
