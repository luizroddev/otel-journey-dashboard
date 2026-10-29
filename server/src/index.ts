// Entry point. MODE=all runs the OTLP receiver, the aggregator and the
// dashboard; `ingest` only the receiver; `query` the aggregator and the
// dashboard, reading spans and events that something else (for example a
// BFF) inserts.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { startAggregator } from './aggregate/aggregator.js';
import { loadConfig } from './config.js';
import { dashboardRoutes } from './http/dashboard.js';
import { ingestRoutes } from './http/ingest.js';
import { connect, ensureIndexes } from './store/mongo.js';

const config = loadConfig();
const store = await connect(config.mongoUrl, config.mongoDb, config.collectionPrefix);
const aggregates = config.mode !== 'ingest' && config.aggregator;
await ensureIndexes(store, { raw: config.mode !== 'query', derived: aggregates });
const stopAggregator = aggregates ? startAggregator(store, config) : () => {};

if (config.mode !== 'query') {
  serve({ fetch: ingestRoutes(store, config).fetch, port: config.otlpPort, hostname: config.host });
  console.log(`OTLP receiver on http://${config.host}:${config.otlpPort} (/v1/traces, /v1/logs)`);
}

if (config.mode !== 'ingest') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The built UI (npm run build); in development Vite serves it instead.
  const webDir = [path.resolve(here, '../../web'), path.resolve(process.cwd(), 'dist/web')].find(
    (d) => existsSync(path.join(d, 'index.html')) && existsSync(path.join(d, 'assets')),
  );
  serve({ fetch: dashboardRoutes(store, config, webDir).fetch, port: config.httpPort, hostname: config.host });
  console.log(
    `Dashboard on http://localhost:${config.httpPort}${config.basePath}${webDir ? '' : ' (API only: run npm run build for the UI)'}`,
  );
}

const stop = async () => {
  stopAggregator();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
