// Entry point. MODE=all runs the OTLP receiver and the dashboard; `ingest`
// only the receiver; `query` only the dashboard and its API, reading a
// MongoDB that something else (for example a BFF) fills.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { apiRoutes } from './http/api.js';
import { ingestRoutes } from './http/ingest.js';
import { connect, ensureIndexes } from './store/mongo.js';

const config = loadConfig();
const store = await connect(config.mongoUrl, config.mongoDb);
if (config.mode !== 'query') await ensureIndexes(store);

if (config.mode !== 'query') {
  serve({ fetch: ingestRoutes(store, config).fetch, port: config.otlpPort, hostname: config.host });
  console.log(`OTLP receiver on http://${config.host}:${config.otlpPort} (/v1/traces, /v1/logs)`);
}

if (config.mode !== 'ingest') {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, mode: config.mode }));
  app.route('/api', apiRoutes(store, config));

  const here = path.dirname(fileURLToPath(import.meta.url));
  // The built UI (npm run build); in development Vite serves it instead.
  const webDir = [path.resolve(here, '../../web'), path.resolve(process.cwd(), 'dist/web')].find(
    (d) => existsSync(path.join(d, 'index.html')) && existsSync(path.join(d, 'assets')),
  );
  if (webDir) {
    const root = path.relative(process.cwd(), webDir) || '.';
    const index = path.join(webDir, 'index.html');
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(readFileSync(index, 'utf8'))); // client-side routes
  }
  serve({ fetch: app.fetch, port: config.httpPort, hostname: config.host });
  console.log(`Dashboard on http://localhost:${config.httpPort}${webDir ? '' : ' (API only: run npm run build for the UI)'}`);
}

const stop = async () => {
  await store.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
