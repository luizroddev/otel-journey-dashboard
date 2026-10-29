// The overview: how the journeys went in a period and what changed against
// another one. Reads only `rollups` (docs/storage-schema.md): three
// aggregations over hourly counters, whatever the volume of events.
import type { Document } from 'mongodb';
import type { Outcome, RollupDoc } from '../model.js';
import { DURATION_BOUNDS_MS } from '../model.js';
import { unescapeKey } from '../aggregate/aggregator.js';
import type { Store } from '../store/mongo.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUCKETS = DURATION_BOUNDS_MS.length + 1;

export type PeriodKey = '24h' | '7d' | '30d';
export type CompareKey = 'previous' | 'week';

export interface OverviewQuery {
  period: PeriodKey;
  /** `week`: the same hours a week earlier (24 h period only). */
  compare: CompareKey;
  /** IANA time zone of the reader, for day slots. */
  timeZone: string;
  service?: string;
  version?: string;
  platform?: string;
  environment?: string;
  now: Date;
  /** Smallest group (runs, sessions, measured actions) a comparison is made on. */
  minVolume: number;
}

export interface Counters {
  n: number;
  success: number;
  failure: number;
  cancelled: number;
  completed: number;
  failed: number;
}

export interface Rate {
  n: number;
  failure: number;
}

export interface ReasonCount {
  outcome: Outcome;
  /** `journey.outcome_reason`, or null when only `error.type` is known. */
  reason: string | null;
  errorType: string | null;
  now: number;
  before: number;
}

export interface FlowStat {
  code: string;
  label: string | null;
  started: number;
  success: number;
  failure: number;
  cancelled: number;
  completed: number;
  /** Started with no end received (yet). */
  open: number;
  p95Ms: number | null;
  before: { started: number; failure: number; open: number; p95Ms: number | null };
  /** Per slot; `started - ended` is what has no conclusion. */
  series: { started: number[]; failure: number[]; ended: number[] };
  reasons: ReasonCount[];
  byVersion: { version: string | null; platform: string | null; started: number; failure: number; before: Rate; series: { started: number[]; failure: number[] } }[];
}

export interface ActionStat {
  code: string;
  label: string | null;
  n: number;
  failure: number;
  measured: number;
  p95Ms: number | null;
  before: { n: number; failure: number; measured: number; p95Ms: number | null };
}

export interface VersionStat {
  version: string | null;
  platform: string | null;
  sessions: number;
  failedSessions: number;
  before: { sessions: number; failedSessions: number };
  flows: Record<string, Rate>;
}

export type Change =
  | {
      type: 'failure';
      direction: 'worse' | 'better';
      code: string;
      label: string | null;
      now: Rate;
      before: Rate;
      /** First slot of the rise, when it started inside the period. */
      since: string | null;
      /** The version and platform that hold most of the difference. */
      where: { version: string | null; platform: string | null; share: number } | null;
      /**
       * The reason whose share of the failures moved most. `beforeScope`:
       * whether the earlier share is of that version or of the whole flow.
       */
      reason: { reason: string | null; errorType: string | null; shareBefore: number; shareNow: number; beforeScope: 'version' | 'flow' } | null;
      impact: number;
    }
  | {
      type: 'duration';
      direction: 'worse' | 'better';
      code: string;
      label: string | null;
      nowMs: number;
      beforeMs: number;
      measured: number;
      impact: number;
    };

export interface Overview {
  period: { key: PeriodKey; from: string; to: string };
  previous: { key: CompareKey; from: string; to: string };
  slot: 'hour' | 'day';
  slots: string[];
  /** Everything received up to this instant is counted. */
  updatedAt: string | null;
  minVolume: number;
  sessions: { now: number; before: number; series: number[] };
  failedSessions: { now: number; before: number; series: number[] };
  flows: FlowStat[];
  actions: ActionStat[];
  versions: VersionStat[];
  changes: Change[];
}

interface Window {
  slot: 'hour' | 'day';
  from: Date;
  to: Date;
  slots: Date[];
  shift: number;
  /** Elapsed fraction of the current hour: the previous window's last hour counts that much. */
  fraction: number;
}

/** The hours of the period, aligned to whole hours (and local days for 7 and 30 days). */
export function periodWindow(q: Pick<OverviewQuery, 'period' | 'compare' | 'timeZone' | 'now'>): Window {
  const now = q.now.getTime();
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const to = new Date(thisHour + HOUR);
  const fraction = (now - thisHour) / HOUR;
  if (q.period === '24h') {
    const from = new Date(to.getTime() - DAY);
    const slots = Array.from({ length: 24 }, (_, i) => new Date(from.getTime() + i * HOUR));
    return { slot: 'hour', from, to, slots, shift: q.compare === 'week' ? 7 * DAY : DAY, fraction };
  }
  const days = q.period === '7d' ? 7 : 30;
  const today = thisHour - localHour(q.timeZone, q.now) * HOUR;
  const from = new Date(today - (days - 1) * DAY);
  const slots = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * DAY));
  return { slot: 'day', from, to, slots, shift: days * DAY, fraction };
}

function localHour(timeZone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at)) % 24;
}

export function validTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const COUNTERS = ['n', 'success', 'failure', 'cancelled', 'completed', 'failed'] as const;
const zero = (): Counters => ({ n: 0, success: 0, failure: 0, cancelled: 0, completed: 0, failed: 0 });
const add = (a: Counters, b: Partial<Counters>, by = 1) => {
  for (const k of COUNTERS) a[k] += (b[k] ?? 0) * by;
};

interface Group {
  kind: RollupDoc['kind'];
  code: string;
  version: string | null;
  platform: string | null;
  label: string | null;
  slot?: Date;
  c: Counters;
}

interface WindowData {
  groups: Group[];
  durations: Map<string, number[]>;
  reasons: { kind: string; code: string; version: string | null; platform: string | null; outcome: Outcome; reason: string | null; errorType: string | null; n: number }[];
}

async function readWindow(s: Store, q: OverviewQuery, from: Date, to: Date, slotUnit: 'hour' | 'day' | null): Promise<WindowData> {
  const match: Document = { kind: { $in: ['session', 'flow', 'action'] }, hour: { $gte: from, $lt: to } };
  for (const k of ['service', 'version', 'platform', 'environment'] as const) if (q[k]) match[k] = q[k];
  const sums = Object.fromEntries(COUNTERS.map((k) => [k, { $sum: `$${k}` }]));
  const slot = slotUnit === 'hour' ? '$hour' : slotUnit === 'day' ? { $dateTrunc: { date: '$hour', unit: 'day', timezone: q.timeZone } } : null;
  const dims = { kind: '$kind', code: '$code', version: '$version', platform: '$platform' };
  const [r] = await s.rollups
    .aggregate<{ series: Document[]; durations: Document[]; reasons: Document[]; errors: Document[] }>([
      { $match: match },
      {
        $facet: {
          series: [{ $group: { _id: { ...dims, ...(slot ? { slot } : {}) }, ...sums, label: { $max: '$label' } } }],
          durations: [
            { $match: { dur: { $exists: true } } },
            {
              $group: {
                _id: { kind: '$kind', code: '$code' },
                ...Object.fromEntries(Array.from({ length: BUCKETS }, (_, i) => [`d${i}`, { $sum: `$dur.${i}` }])),
              },
            },
          ],
          reasons: [
            { $match: { reasons: { $exists: true } } },
            { $project: { ...dims, r: { $objectToArray: '$reasons' } } },
            { $unwind: '$r' },
            { $project: { kind: 1, code: 1, version: 1, platform: 1, outcome: '$r.k', rr: { $objectToArray: '$r.v' } } },
            { $unwind: '$rr' },
            { $group: { _id: { ...dims, outcome: '$outcome', reason: '$rr.k' }, n: { $sum: '$rr.v' } } },
          ],
          errors: [
            { $match: { errors: { $exists: true } } },
            { $project: { ...dims, e: { $objectToArray: '$errors' } } },
            { $unwind: '$e' },
            { $group: { _id: { ...dims, errorType: '$e.k' }, n: { $sum: '$e.v' } } },
          ],
        },
      },
    ])
    .toArray();
  const groups = r!.series.map((d) => {
    const c = zero();
    add(c, d as Partial<Counters>);
    return { kind: d._id.kind, code: d._id.code, version: d._id.version ?? null, platform: d._id.platform ?? null, label: d.label ?? null, slot: d._id.slot, c };
  });
  const durations = new Map<string, number[]>(
    r!.durations.map((d) => [`${d._id.kind}|${d._id.code}`, Array.from({ length: BUCKETS }, (_, i) => d[`d${i}`] ?? 0)]),
  );
  const reasons = [
    ...r!.reasons.map((d) => ({ ...d._id, version: d._id.version ?? null, platform: d._id.platform ?? null, reason: unescapeKey(d._id.reason), errorType: null, n: d.n })),
    ...r!.errors.map((d) => ({ ...d._id, version: d._id.version ?? null, platform: d._id.platform ?? null, outcome: 'failure' as Outcome, reason: null, errorType: unescapeKey(d._id.errorType), n: d.n })),
  ];
  return { groups, durations, reasons };
}

/** p95 from the duration histogram, interpolated inside its bucket. Null under 20 values. */
export function percentile(hist: number[] | undefined, p = 0.95): number | null {
  if (!hist) return null;
  const total = hist.reduce((a, b) => a + b, 0);
  if (total < 20) return null;
  const target = total * p;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i]!;
    if (seen + count >= target && count > 0) {
      const lo = i === 0 ? 0 : DURATION_BOUNDS_MS[i - 1]!;
      const hi = DURATION_BOUNDS_MS[i] ?? lo * 2;
      return lo + ((target - seen) / count) * (hi - lo);
    }
    seen += count;
  }
  return DURATION_BOUNDS_MS[DURATION_BOUNDS_MS.length - 1]!;
}

export async function buildOverview(s: Store, q: OverviewQuery, updatedAt: Date | null): Promise<Overview> {
  const w = periodWindow(q);
  const prevFrom = new Date(w.from.getTime() - w.shift);
  const prevTo = new Date(w.to.getTime() - w.shift);
  const [now, before, lastHour] = await Promise.all([
    readWindow(s, q, w.from, w.to, w.slot),
    readWindow(s, q, prevFrom, prevTo, null),
    readWindow(s, q, new Date(prevTo.getTime() - HOUR), prevTo, null),
  ]);
  // The current hour is partial: compare it with the same part of the
  // previous window's last hour.
  const prev = new Map<string, Group>();
  const key = (g: Pick<Group, 'kind' | 'code' | 'version' | 'platform'>) => `${g.kind}|${g.code}|${g.version}|${g.platform}`;
  for (const g of before.groups) prev.set(key(g), g);
  for (const g of lastHour.groups) {
    const p = prev.get(key(g));
    if (p) add(p.c, g.c, -(1 - w.fraction));
  }
  return summarize(w, now, { ...before, groups: [...prev.values()] }, q, updatedAt);
}

/** Everything after the queries. Pure. */
export function summarize(w: Window, now: WindowData, before: WindowData, q: OverviewQuery, updatedAt: Date | null): Overview {
  const slotIndex = (d: Date | undefined) => {
    if (!d) return -1;
    const i = Math.round((d.getTime() - w.from.getTime()) / (w.slot === 'hour' ? HOUR : DAY));
    return i >= 0 && i < w.slots.length ? i : -1;
  };
  const series = () => w.slots.map(() => 0);
  const of = (data: WindowData, kind: Group['kind']) => data.groups.filter((g) => g.kind === kind);
  const total = (groups: Group[]) => groups.reduce((c, g) => (add(c, g.c), c), zero());

  const sessionsNow = of(now, 'session');
  const sessionSeries = series();
  const failedSeries = series();
  for (const g of sessionsNow) {
    const i = slotIndex(g.slot);
    if (i < 0) continue;
    sessionSeries[i]! += g.c.n;
    failedSeries[i]! += g.c.failed;
  }
  const sNow = total(sessionsNow);
  const sBefore = total(of(before, 'session'));

  const reasonsOf = (kind: string, code: string, filter?: (r: WindowData['reasons'][number]) => boolean) => {
    const m = new Map<string, ReasonCount>();
    for (const [data, field] of [
      [now, 'now'],
      [before, 'before'],
    ] as const) {
      for (const r of data.reasons) {
        if (r.kind !== kind || r.code !== code || (filter && !filter(r))) continue;
        const k = `${r.outcome}|${r.reason}|${r.errorType}`;
        let x = m.get(k);
        if (!x) m.set(k, (x = { outcome: r.outcome, reason: r.reason, errorType: r.errorType, now: 0, before: 0 }));
        x[field] += r.n;
      }
    }
    return [...m.values()].sort((a, b) => b.now - a.now || b.before - a.before);
  };

  const flowCodes = [...new Set(of(now, 'flow').map((g) => g.code))];
  const flows: FlowStat[] = flowCodes.map((code) => {
    const gs = of(now, 'flow').filter((g) => g.code === code);
    const bs = of(before, 'flow').filter((g) => g.code === code);
    const c = total(gs);
    const b = total(bs);
    const ended = (x: Counters) => x.success + x.failure + x.cancelled + x.completed;
    const started = series();
    const failure = series();
    const endedSeries = series();
    const versions = new Map<string, FlowStat['byVersion'][number]>();
    for (const g of gs) {
      const i = slotIndex(g.slot);
      const vk = `${g.version}|${g.platform}`;
      let v = versions.get(vk);
      if (!v) {
        const vb = total(bs.filter((x) => x.version === g.version && x.platform === g.platform));
        versions.set(vk, (v = { version: g.version, platform: g.platform, started: 0, failure: 0, before: { n: vb.n, failure: vb.failure }, series: { started: series(), failure: series() } }));
      }
      v.started += g.c.n;
      v.failure += g.c.failure;
      if (i >= 0) {
        started[i]! += g.c.n;
        failure[i]! += g.c.failure;
        endedSeries[i]! += ended(g.c);
        v.series.started[i]! += g.c.n;
        v.series.failure[i]! += g.c.failure;
      }
    }
    return {
      code,
      label: gs.find((g) => g.label)?.label ?? null,
      started: c.n,
      success: c.success,
      failure: c.failure,
      cancelled: c.cancelled,
      completed: c.completed,
      open: Math.max(0, c.n - ended(c)),
      p95Ms: percentile(now.durations.get(`flow|${code}`)),
      before: { started: b.n, failure: b.failure, open: Math.max(0, b.n - ended(b)), p95Ms: percentile(before.durations.get(`flow|${code}`)) },
      series: { started, failure, ended: endedSeries },
      reasons: reasonsOf('flow', code),
      byVersion: [...versions.values()].sort((a, b2) => b2.started - a.started),
    };
  });
  flows.sort((a, b) => b.started - a.started);

  const actionCodes = [...new Set(of(now, 'action').map((g) => g.code))];
  const measured = (h: number[] | undefined) => (h ?? []).reduce((a, b) => a + b, 0);
  const actions: ActionStat[] = actionCodes.map((code) => {
    const c = total(of(now, 'action').filter((g) => g.code === code));
    const b = total(of(before, 'action').filter((g) => g.code === code));
    const h = now.durations.get(`action|${code}`);
    const hb = before.durations.get(`action|${code}`);
    return {
      code,
      label: of(now, 'action').find((g) => g.code === code && g.label)?.label ?? null,
      n: c.n,
      failure: c.failure,
      measured: measured(h),
      p95Ms: percentile(h),
      before: { n: b.n, failure: b.failure, measured: measured(hb), p95Ms: percentile(hb) },
    };
  });
  actions.sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || b.n - a.n);

  const versionMap = new Map<string, VersionStat>();
  const version = (g: Group) => {
    const k = `${g.version}|${g.platform}`;
    let v = versionMap.get(k);
    if (!v) versionMap.set(k, (v = { version: g.version, platform: g.platform, sessions: 0, failedSessions: 0, before: { sessions: 0, failedSessions: 0 }, flows: {} }));
    return v;
  };
  for (const g of sessionsNow) {
    const v = version(g);
    v.sessions += g.c.n;
    v.failedSessions += g.c.failed;
  }
  for (const g of of(before, 'session')) {
    if (!versionMap.has(`${g.version}|${g.platform}`)) continue;
    const v = version(g);
    v.before.sessions += g.c.n;
    v.before.failedSessions += g.c.failed;
  }
  for (const g of of(now, 'flow')) {
    const v = version(g);
    const f = (v.flows[g.code] ??= { n: 0, failure: 0 });
    f.n += g.c.n;
    f.failure += g.c.failure;
  }
  const versions = [...versionMap.values()].sort((a, b) => b.sessions - a.sessions);

  return {
    period: { key: q.period, from: w.from.toISOString(), to: w.to.toISOString() },
    previous: {
      key: q.period === '24h' ? q.compare : 'previous',
      from: new Date(w.from.getTime() - w.shift).toISOString(),
      to: new Date(w.to.getTime() - w.shift).toISOString(),
    },
    slot: w.slot,
    slots: w.slots.map((d) => d.toISOString()),
    updatedAt: updatedAt?.toISOString() ?? null,
    minVolume: q.minVolume,
    sessions: { now: sNow.n, before: sBefore.n, series: sessionSeries },
    failedSessions: { now: sNow.failed, before: sBefore.failed, series: failedSeries },
    flows,
    actions,
    versions,
    changes: findChanges(flows, actions, w.slots, { now: now.reasons, before: before.reasons }, q.minVolume),
  };
}

/** Two-proportion z score. */
function zScore(a: Rate, b: Rate): number {
  const p = (a.failure + b.failure) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se > 0 ? (a.failure / a.n - b.failure / b.n) / se : 0;
}

/**
 * What changed, worst first. A comparison needs `minVolume` on both sides,
 * a difference unlikely to be noise (|z| >= 3) and big enough to matter
 * (0.5 percentage point and 20% of the earlier rate; 25% and 200 ms for
 * durations). It says where to look, not why.
 */
export function findChanges(
  flows: FlowStat[],
  actions: ActionStat[],
  slots: Date[],
  reasons: { now: WindowData['reasons']; before: WindowData['reasons'] },
  minVolume: number,
): Change[] {
  const out: Change[] = [];
  const rate = (r: Rate) => (r.n > 0 ? r.failure / r.n : 0);
  for (const f of flows) {
    const a: Rate = { n: f.started, failure: f.failure };
    const b: Rate = { n: f.before.started, failure: f.before.failure };
    if (a.n < minVolume || b.n < minVolume) continue;
    const delta = rate(a) - rate(b);
    if (Math.abs(zScore(a, b)) < 3 || Math.abs(delta) < 0.005 || Math.abs(delta) < 0.2 * Math.max(rate(b), 0.001)) continue;
    const direction = delta > 0 ? 'worse' : 'better';
    const sign = delta > 0 ? 1 : -1;

    // Where: the version holding most of the extra (or missing) failures.
    const base = rate(b);
    const extra = f.byVersion.map((v) => {
      const ref = v.before.n >= minVolume / 4 ? rate(v.before) : base;
      return { v, extra: sign * (v.failure - v.started * ref) };
    });
    const positive = extra.filter((x) => x.extra > 0);
    const sum = positive.reduce((n, x) => n + x.extra, 0);
    const top = positive.sort((x, y) => y.extra - x.extra)[0];
    const where = top && sum > 0 && top.extra / sum >= 0.5 && top.v.started >= minVolume / 4 ? { version: top.v.version, platform: top.v.platform, share: top.extra / sum } : null;

    // Why: the reason whose share of the failures moved most, in that
    // version when there is one. Before, the version may have had too few
    // failures (or not exist): then the whole flow is the reference.
    const inVersion = (r: { version: string | null; platform: string | null }) =>
      !!where && r.version === where.version && r.platform === where.platform;
    const failuresOf = (list: WindowData['reasons']) => list.filter((r) => r.kind === 'flow' && r.code === f.code && r.outcome === 'failure');
    const nowList = failuresOf(reasons.now).filter((r) => !where || inVersion(r));
    const versionBefore = failuresOf(reasons.before).filter(inVersion);
    const beforeScope: 'version' | 'flow' = where && versionBefore.reduce((n, r) => n + r.n, 0) >= 10 ? 'version' : 'flow';
    const beforeList = beforeScope === 'version' ? versionBefore : failuresOf(reasons.before);
    const counts = new Map<string, { reason: string | null; errorType: string | null; now: number; before: number }>();
    for (const [list, field] of [
      [nowList, 'now'],
      [beforeList, 'before'],
    ] as const) {
      for (const r of list) {
        const k = `${r.reason}|${r.errorType}`;
        const x = counts.get(k) ?? { reason: r.reason, errorType: r.errorType, now: 0, before: 0 };
        x[field] += r.n;
        counts.set(k, x);
      }
    }
    const nowTotal = [...counts.values()].reduce((n, x) => n + x.now, 0);
    const beforeTotal = [...counts.values()].reduce((n, x) => n + x.before, 0);
    const moved = [...counts.values()]
      .map((x) => ({ ...x, shareNow: nowTotal ? x.now / nowTotal : 0, shareBefore: beforeTotal ? x.before / beforeTotal : 0 }))
      .filter((x) => x.now >= 10 || x.before >= 10)
      .sort((x, y) => sign * (y.shareNow - y.shareBefore) - sign * (x.shareNow - x.shareBefore))[0];
    const reason =
      moved && sign * (moved.shareNow - moved.shareBefore) >= 0.1
        ? { reason: moved.reason, errorType: moved.errorType, shareBefore: moved.shareBefore, shareNow: moved.shareNow, beforeScope }
        : null;

    // Since: the first slot of the last stretch above the midpoint.
    let since: string | null = null;
    if (direction === 'worse') {
      const v = where && f.byVersion.find((x) => x.version === where.version && x.platform === where.platform);
      const s = v ? v.series : f.series;
      const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
      const was = v && v.before.n >= minVolume / 4 ? rate(v.before) : rate(b);
      const mid = (was + rate({ n: sum(s.started), failure: sum(s.failure) })) / 2;
      let start = -1;
      for (let i = 0; i < slots.length; i++) {
        if (s.started[i]! < 10) continue;
        if (s.failure[i]! / s.started[i]! <= mid) start = -1;
        else if (start < 0) start = i;
      }
      if (start > 0) since = slots[start]!.toISOString();
    }
    out.push({ type: 'failure', direction, code: f.code, label: f.label, now: a, before: b, since, where, reason, impact: Math.abs(delta) * a.n });
  }
  for (const x of actions) {
    if (x.p95Ms === null || x.before.p95Ms === null || x.measured < minVolume || x.before.measured < minVolume) continue;
    const ratio = x.p95Ms / x.before.p95Ms;
    const diff = Math.abs(x.p95Ms - x.before.p95Ms);
    if (diff < 200 || (ratio < 1.25 && ratio > 0.8)) continue;
    out.push({
      type: 'duration',
      direction: ratio > 1 ? 'worse' : 'better',
      code: x.code,
      label: x.label,
      nowMs: x.p95Ms,
      beforeMs: x.before.p95Ms,
      measured: x.measured,
      impact: (diff / 1000) * x.measured,
    });
  }
  const order = (c: Change) => (c.direction === 'worse' ? 0 : 2) + (c.type === 'failure' ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b) || b.impact - a.impact);
}
