// Query API read by the dashboard. Contract in docs/query-api.md.
import { Hono } from 'hono';
import { aggregatedUpTo } from '../aggregate/aggregator.js';
import type { Config } from '../config.js';
import { buildJourney } from '../query/journey.js';
import { buildTrace, withContext } from '../query/trace.js';
import {
  facets,
  getSession,
  listSessions,
  sessionEvents,
  sessionRootSpans,
  traceEvents,
  traceSpans,
  type Store,
} from '../store/mongo.js';

const DAY = 86_400_000;

function window(from: string | undefined, to: string | undefined, maxDays: number) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - DAY);
  if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) return null;
  if (start > end) return null;
  const min = new Date(end.getTime() - maxDays * DAY);
  return { from: start < min ? min : start, to: end, clamped: start < min };
}

/** `failedFlow` or `failedAction`, with optional `reason` / `errorType`. */
function failedFilter(q: Record<string, string>) {
  const kind = q.failedFlow ? 'flow' : q.failedAction ? 'action' : null;
  if (!kind) return undefined;
  return {
    kind,
    code: (kind === 'flow' ? q.failedFlow : q.failedAction)!,
    reason: q.reason || undefined,
    errorType: q.errorType || undefined,
  } as const;
}

export function apiRoutes(store: Store, config: Config) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (config.apiToken && c.req.header('authorization') !== `Bearer ${config.apiToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.get('/sessions', async (c) => {
    const q = c.req.query();
    const w = window(q.from, q.to, config.maxWindowDays);
    if (!w) return c.json({ error: 'invalid period' }, 400);
    const limit = Math.min(Number(q.limit) || 50, config.maxPageSize);
    const before = q.before ? new Date(q.before) : undefined;
    const items = await listSessions(store, {
      ...w,
      deviceId: q.deviceId || undefined,
      installationId: q.installationId || undefined,
      userId: q.userId || undefined,
      sessionId: q.sessionId || undefined,
      service: q.service || undefined,
      version: q.version || undefined,
      platform: q.platform || undefined,
      environment: q.environment || undefined,
      onlyErrors: q.onlyErrors === 'true',
      flow: q.flow || undefined,
      failed: failedFilter(q),
      limit: limit + 1,
      before: before && !Number.isNaN(before.getTime()) ? before : undefined,
    });
    const page = items.slice(0, limit);
    return c.json({
      items: page,
      nextBefore: items.length > limit ? page[page.length - 1]!.lastSeen.toISOString() : null,
      period: { from: w.from.toISOString(), to: w.to.toISOString(), clamped: w.clamped },
    });
  });

  app.get('/status', async (c) => {
    const done = await aggregatedUpTo(store);
    return c.json({ aggregatedUpTo: done?.toISOString() ?? null });
  });

  app.get('/sessions/:id', async (c) => {
    const s = await getSession(store, c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'not found' }, 404);
  });

  app.get('/sessions/:id/journey', async (c) => {
    const id = c.req.param('id');
    const [session, events, roots] = await Promise.all([
      getSession(store, id),
      sessionEvents(store, id, config.maxJourneyEvents + 1),
      sessionRootSpans(store, id, config.maxTraceSpans + 1),
    ]);
    if (!session) return c.json({ error: 'not found' }, 404);
    const view = buildJourney(events.slice(0, config.maxJourneyEvents), roots.slice(0, config.maxTraceSpans));
    return c.json({
      session,
      ...view,
      limits: {
        events: { loaded: Math.min(events.length, config.maxJourneyEvents), truncated: events.length > config.maxJourneyEvents },
        rootSpans: { loaded: Math.min(roots.length, config.maxTraceSpans), truncated: roots.length > config.maxTraceSpans },
      },
    });
  });

  app.get('/traces/:traceId', async (c) => {
    const traceId = c.req.param('traceId').toLowerCase();
    const [spans, events] = await Promise.all([
      traceSpans(store, traceId, config.maxTraceSpans + 1),
      traceEvents(store, traceId, config.maxJourneyEvents),
    ]);
    if (spans.length === 0 && events.length === 0) return c.json({ error: 'not found' }, 404);
    return c.json({
      ...buildTrace(traceId, spans.slice(0, config.maxTraceSpans).map(withContext)),
      events,
      truncated: spans.length > config.maxTraceSpans,
    });
  });

  app.get('/facets', async (c) => {
    const w = window(c.req.query('from'), c.req.query('to'), config.maxWindowDays);
    if (!w) return c.json({ error: 'invalid period' }, 400);
    return c.json(await facets(store, w.from, w.to));
  });

  return app;
}
