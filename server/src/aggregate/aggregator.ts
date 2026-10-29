// Derives `sessions` and `rollups` from what writers inserted into `spans`
// and `events`, so a writer (the bundled receiver, a BFF) only inserts.
//
// It reads records by `receivedAt`, in chunks (done, to]. Before a chunk it
// records `pending: to`; every document it touches is updated only while
// its `upTo` is older than `to`. A chunk redone after a crash, or by another
// instance that took over, therefore never counts twice. One instance at a
// time holds the job (a lease in `jobs`).
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { MongoBulkWriteError, MongoServerError, type AnyBulkWriteOperation, type Collection, type Document } from 'mongodb';
import type { Config } from '../config.js';
import type { Attr, EventDoc, JobDoc, Outcome, RollupDoc, RollupKind, SessionDoc, SessionFailure, SpanDoc } from '../model.js';
import { DURATION_BOUNDS_MS, EventNames, Keys } from '../model.js';
import type { Store } from '../store/mongo.js';

const JOB = 'aggregate';
const HOUR = 3_600_000;

export interface AggregateOptions {
  now: Date;
  /** Records received in the last `lagMs` wait for the next run (slow inserts, writer clocks). */
  lagMs: number;
  /** First chunk length; it grows while chunks are small and shrinks when they are big. */
  chunkMs: number;
  owner: string;
  leaseMs: number;
  rollupRetentionDays: number;
}

export interface AggregateResult {
  chunks: number;
  records: number;
  done: Date;
}

/** Runs the job until it caught up with `now - lagMs`. Null when another instance holds it. */
export async function aggregateOnce(s: Store, o: AggregateOptions): Promise<AggregateResult | null> {
  const job = await acquire(s, o);
  if (!job) return null;
  let done = job.done ?? (await start(s, o));
  let pending = job.pending && job.pending > done ? job.pending : null;
  const limit = o.now.getTime() - o.lagMs;
  let span = o.chunkMs;
  let chunks = 0;
  let records = 0;
  for (;;) {
    const to = pending ?? new Date(Math.min(limit, done.getTime() + span));
    if (to <= done) break;
    if (!pending && !(await claim(s, o, { pending: to }))) break;
    const n = await applyChunk(s, done, to, o);
    if (!(await claim(s, o, { done: to, pending: null }))) break;
    done = to;
    pending = null;
    chunks++;
    records += n;
    span = n < 10_000 ? Math.min(span * 2, 6 * HOUR) : n > 50_000 ? Math.max(span / 2, 5_000) : span;
  }
  return { chunks, records, done };
}

/** Starts the job every `aggregateEveryMs`. Returns a function that stops it. */
export function startAggregator(s: Store, c: Config): () => void {
  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await aggregateOnce(s, {
        now: new Date(),
        lagMs: c.aggregateLagMs,
        chunkMs: 60_000,
        owner,
        leaseMs: Math.max(c.aggregateEveryMs * 4, 60_000),
        rollupRetentionDays: c.rollupRetentionDays,
      });
    } catch (e) {
      console.error(`aggregator: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), c.aggregateEveryMs);
  return () => clearInterval(timer);
}

/** Until when everything received is aggregated, or null before the first run. */
export async function aggregatedUpTo(s: Store): Promise<Date | null> {
  return (await s.jobs.findOne({ _id: JOB }))?.done ?? null;
}

async function acquire(s: Store, o: AggregateOptions): Promise<JobDoc | null> {
  try {
    return await s.jobs.findOneAndUpdate(
      { _id: JOB, $or: [{ owner: o.owner }, { leaseUntil: { $lt: o.now } }] },
      { $set: { owner: o.owner, leaseUntil: new Date(o.now.getTime() + o.leaseMs) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (e) {
    // Held by another instance: the upsert collides with its document.
    if (e instanceof MongoServerError && e.code === 11000) return null;
    throw e;
  }
}

/** Updates the job while this instance still holds it. */
async function claim(s: Store, o: AggregateOptions, set: Partial<JobDoc>): Promise<boolean> {
  const r = await s.jobs.updateOne(
    { _id: JOB, owner: o.owner },
    { $set: { ...set, leaseUntil: new Date(o.now.getTime() + o.leaseMs) } },
  );
  return r.matchedCount === 1;
}

/**
 * First run: the derived collections are rebuilt from every record still
 * stored (a version 2 writer kept `sessions` itself, with other counts).
 */
async function start(s: Store, o: AggregateOptions): Promise<Date> {
  await Promise.all([s.sessions.deleteMany({}), s.rollups.deleteMany({})]);
  const firsts = await Promise.all(
    [s.events, s.spans].map((c) =>
      (c as unknown as Collection<Document>).find({}, { projection: { receivedAt: 1 } }).sort({ receivedAt: 1 }).limit(1).next(),
    ),
  );
  const times = firsts.map((d) => (d?.receivedAt as Date | undefined)?.getTime()).filter((t): t is number => t !== undefined);
  const done = new Date(times.length ? Math.min(...times) - 1 : o.now.getTime() - o.lagMs);
  await claim(s, o, { done, pending: null });
  return done;
}

type Dims = Pick<RollupDoc, 'service' | 'version' | 'platform' | 'environment'>;

/** Per session, what one chunk adds. */
interface Touch {
  dims: Dims;
  first: Date;
  last: Date;
  firstError: Date | null;
  events: number;
  spans: number;
  errors: number;
  expireAt: Date;
  deviceId: string | null;
  installationId: string | null;
  previousSessionId: string | null;
  userIds: Set<string>;
  services: Set<string>;
  versions: Set<string>;
  platforms: Set<string>;
  environments: Set<string>;
  flows: Set<string>;
  failures: Map<string, SessionFailure>;
}

/** Counters of one rollup document in one chunk. */
interface Acc {
  hour: Date;
  dims: Dims;
  kind: RollupKind;
  code: string;
  label: string | null;
  inc: Record<string, number>;
}

type EventRow = Pick<
  EventDoc,
  | 'sessionId'
  | 'time'
  | 'eventName'
  | 'flow'
  | 'flowLabel'
  | 'actionName'
  | 'actionLabel'
  | 'outcome'
  | 'outcomeReason'
  | 'errorType'
  | 'durationMs'
  | 'userId'
  | 'deviceId'
  | 'installationId'
  | 'service'
  | 'serviceVersion'
  | 'platform'
  | 'environment'
  | 'expireAt'
> & { attributes?: Attr[] };

type SpanRow = Pick<
  SpanDoc,
  | 'sessionId'
  | 'start'
  | 'end'
  | 'statusCode'
  | 'parentSpanId'
  | 'actionInstanceId'
  | 'userId'
  | 'deviceId'
  | 'installationId'
  | 'service'
  | 'serviceVersion'
  | 'platform'
  | 'environment'
  | 'expireAt'
>;

const COMMON = {
  sessionId: 1,
  userId: 1,
  deviceId: 1,
  installationId: 1,
  service: 1,
  serviceVersion: 1,
  platform: 1,
  environment: 1,
  expireAt: 1,
} as const;

async function applyChunk(s: Store, from: Date, to: Date, o: AggregateOptions): Promise<number> {
  const range = { receivedAt: { $gt: from, $lte: to } };
  const [events, spans] = await Promise.all([
    s.events
      .find(range, {
        projection: {
          ...COMMON,
          time: 1,
          eventName: 1,
          flow: 1,
          flowLabel: 1,
          actionName: 1,
          actionLabel: 1,
          outcome: 1,
          outcomeReason: 1,
          errorType: 1,
          durationMs: 1,
          attributes: { $elemMatch: { key: Keys.sessionPreviousId } },
        },
      })
      .toArray() as Promise<EventRow[]>,
    s.spans
      .find(
        { ...range, sessionId: { $ne: null } },
        { projection: { ...COMMON, start: 1, end: 1, statusCode: 1, parentSpanId: 1, actionInstanceId: 1 } },
      )
      .toArray() as Promise<SpanRow[]>,
  ]);
  if (events.length === 0 && spans.length === 0) return 0;

  const touches = new Map<string, Touch>();
  const rollups = new Map<string, Acc>();
  const future = o.now.getTime() + HOUR;
  const roll = (dims: Dims, kind: RollupKind, code: string, at: Date, label: string | null = null): Acc | null => {
    // A device with a wrong clock must not create far-future hours.
    if (at.getTime() > future) return null;
    const hour = new Date(Math.floor(at.getTime() / HOUR) * HOUR);
    const id = rollupId(hour, dims, kind, code);
    let acc = rollups.get(id);
    if (!acc) rollups.set(id, (acc = { hour, dims, kind, code, label: null, inc: {} }));
    if (label) acc.label = label;
    return acc;
  };

  for (const e of events) {
    const dims = dimsOf(e);
    if (e.sessionId) {
      const t = touch(touches, e.sessionId, dims, e.time, e.time, e.expireAt);
      addIdentity(t, e);
      t.events++;
      if (e.eventName === EventNames.sessionStart) {
        const prev = e.attributes?.[0]?.value;
        if (typeof prev === 'string' && prev && prev !== e.sessionId) t.previousSessionId = prev;
      }
      if (e.eventName === EventNames.flowStart && e.flow) t.flows.add(e.flow);
      if (e.outcome === 'failure') {
        t.errors++;
        if (!t.firstError || e.time < t.firstError) t.firstError = e.time;
        const kind = e.eventName === EventNames.flowEnd ? 'flow' : e.eventName === EventNames.action ? 'action' : null;
        const code = kind === 'flow' ? e.flow : e.actionName;
        if (kind && code) {
          const f: SessionFailure = { kind, code, reason: e.outcomeReason ?? null, errorType: e.errorType ?? null };
          t.failures.set(JSON.stringify(f), f);
        }
      }
    }
    if (e.eventName === EventNames.flowStart && e.flow) {
      const acc = roll(dims, 'flow', e.flow, e.time, e.flowLabel);
      if (acc) inc(acc, 'n');
    } else if (e.eventName === EventNames.flowEnd && e.flow) {
      // A run counts in the hour it started, so started and ended compare.
      const started = new Date(e.time.getTime() - Math.max(0, e.durationMs ?? 0));
      const acc = roll(dims, 'flow', e.flow, started, e.flowLabel);
      if (acc) result(acc, e.outcome ?? 'completed', e);
    } else if (e.eventName === EventNames.action && e.actionName) {
      const acc = roll(dims, 'action', e.actionName, e.time, e.actionLabel);
      if (acc) {
        inc(acc, 'n');
        if (e.outcome) result(acc, e.outcome, e);
        else if (e.durationMs !== null && e.durationMs !== undefined) duration(acc, e.durationMs);
      }
    }
  }

  for (const x of spans) {
    if (!x.sessionId) continue;
    const t = touch(touches, x.sessionId, dimsOf(x), x.start, x.end, x.expireAt);
    addIdentity(t, x);
    t.spans++;
    // One error per failed operation: action spans count through their
    // event, child spans through their root.
    if (x.statusCode === 2 && !x.actionInstanceId && !x.parentSpanId) {
      t.errors++;
      if (!t.firstError || x.start < t.firstError) t.firstError = x.start;
    }
  }

  // Sessions seen for the first time, or failing for the first time, count
  // in the `session` rollup. Read before writing: a redone chunk reads the
  // same state, because rollups are written before sessions.
  const ids = [...touches.keys()];
  const known = new Map(
    (await s.sessions.find({ _id: { $in: ids } }, { projection: { errorCount: 1 } }).toArray()).map((d) => [d._id, d.errorCount]),
  );
  for (const [id, t] of touches) {
    if (!known.has(id)) {
      const acc = roll(t.dims, 'session', '', t.first);
      if (acc) inc(acc, 'n');
    }
    if (t.errors > 0 && !(known.get(id)! > 0) && t.firstError) {
      const acc = roll(t.dims, 'session', '', t.firstError);
      if (acc) inc(acc, 'failed');
    }
  }

  const expire = (hour: Date) => new Date(hour.getTime() + o.rollupRetentionDays * 86_400_000);
  await guarded(
    s.rollups,
    [...rollups].map(
      ([id, a]): AnyBulkWriteOperation<RollupDoc> => ({
        updateOne: {
          filter: { _id: id, upTo: { $lt: to } },
          update: {
            $inc: a.inc,
            $set: { upTo: to, ...(a.label ? { label: a.label } : {}) },
            $setOnInsert: { hour: a.hour, ...a.dims, kind: a.kind, code: a.code, expireAt: expire(a.hour) },
          },
          upsert: true,
        },
      }),
    ),
  );
  await guarded(
    s.sessions,
    [...touches].map(([id, t]): AnyBulkWriteOperation<SessionDoc> => {
      // Identity fields take a value when the chunk has one; null until then.
      const set: Record<string, unknown> = { upTo: to };
      const onInsert: Record<string, null> = {};
      for (const field of ['deviceId', 'installationId', 'previousSessionId'] as const) {
        if (t[field]) set[field] = t[field];
        else onInsert[field] = null;
      }
      const each = (v: Iterable<unknown>) => ({ $each: [...v] });
      return {
        updateOne: {
          filter: { _id: id, upTo: { $lt: to } },
          update: {
            $min: { firstSeen: t.first },
            $max: { lastSeen: t.last, expireAt: t.expireAt },
            $inc: { eventCount: t.events, spanCount: t.spans, errorCount: t.errors },
            $addToSet: {
              userIds: each(t.userIds),
              services: each(t.services),
              versions: each(t.versions),
              platforms: each(t.platforms),
              environments: each(t.environments),
              flows: each(t.flows),
              failures: each(t.failures.values()),
            },
            $set: set,
            ...(Object.keys(onInsert).length ? { $setOnInsert: onInsert } : {}),
          } as never,
          upsert: true,
        },
      };
    }),
  );
  return events.length + spans.length;
}

/** Bulk upserts guarded by `upTo`: a duplicate key means "already applied". */
async function guarded<T extends Document>(col: Collection<T>, ops: AnyBulkWriteOperation<T>[]): Promise<void> {
  if (ops.length === 0) return;
  try {
    await col.bulkWrite(ops, { ordered: false });
  } catch (e) {
    if (e instanceof MongoBulkWriteError) {
      const errors = [e.writeErrors].flat();
      if (errors.length > 0 && errors.every((w) => w.code === 11000)) return;
    }
    throw e;
  }
}

function dimsOf(r: { service: string | null; serviceVersion: string | null; platform: string | null; environment: string | null }): Dims {
  return { service: r.service ?? null, version: r.serviceVersion ?? null, platform: r.platform ?? null, environment: r.environment ?? null };
}

export function rollupId(hour: Date, d: Dims, kind: RollupKind, code: string): string {
  return JSON.stringify([hour.toISOString(), d.service, d.version, d.platform, d.environment, kind, code]);
}

function touch(m: Map<string, Touch>, id: string, dims: Dims, first: Date, last: Date, expireAt: Date): Touch {
  let t = m.get(id);
  if (!t) {
    t = {
      dims,
      first,
      last,
      firstError: null,
      events: 0,
      spans: 0,
      errors: 0,
      expireAt,
      deviceId: null,
      installationId: null,
      previousSessionId: null,
      userIds: new Set(),
      services: new Set(),
      versions: new Set(),
      platforms: new Set(),
      environments: new Set(),
      flows: new Set(),
      failures: new Map(),
    };
    m.set(id, t);
  }
  if (first < t.first) {
    t.first = first;
    t.dims = dims;
  }
  if (last > t.last) t.last = last;
  if (expireAt > t.expireAt) t.expireAt = expireAt;
  return t;
}

function addIdentity(t: Touch, r: EventRow | SpanRow): void {
  if (r.userId) t.userIds.add(r.userId);
  if (r.service) t.services.add(r.service);
  if (r.serviceVersion) t.versions.add(r.serviceVersion);
  if (r.platform) t.platforms.add(r.platform);
  if (r.environment) t.environments.add(r.environment);
  if (r.deviceId) t.deviceId = r.deviceId;
  if (r.installationId) t.installationId = r.installationId;
}

const inc = (a: Acc, path: string, by = 1) => {
  a.inc[path] = (a.inc[path] ?? 0) + by;
};

function result(a: Acc, outcome: Outcome, e: EventRow): void {
  inc(a, outcome);
  if (e.outcomeReason) inc(a, `reasons.${outcome}.${escapeKey(e.outcomeReason)}`);
  else if (outcome === 'failure' && e.errorType) inc(a, `errors.${escapeKey(e.errorType)}`);
  if (e.durationMs !== null && e.durationMs !== undefined) duration(a, e.durationMs);
}

function duration(a: Acc, ms: number): void {
  inc(a, `dur.${durationBucket(ms)}`);
}

export function durationBucket(ms: number): number {
  const i = DURATION_BOUNDS_MS.findIndex((b) => ms <= b);
  return i < 0 ? DURATION_BOUNDS_MS.length : i;
}

/** Codes become field names: `.`, `$` and `%` are percent-escaped. */
export function escapeKey(k: string): string {
  return k.slice(0, 120).replace(/[%.$]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function unescapeKey(k: string): string {
  return k.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
