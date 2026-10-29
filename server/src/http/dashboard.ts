// The dashboard under BASE_PATH: the query API, the built UI and its
// client-side routes, so a reverse proxy can mount it on a sub path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Store } from '../store/mongo.js';
import { apiRoutes } from './api.js';

/**
 * The built index.html for [base]. The build uses relative asset URLs
 * (`./assets/`), which break on client-side routes; they become absolute
 * here, and the UI reads the base from the `base-path` meta tag, so one
 * build serves any path.
 */
export function indexHtml(html: string, base: string): string {
  return html
    .replaceAll('"./assets/', `"${base}assets/`)
    .replace(/<meta name="base-path" content="[^"]*"\s*\/?>/, `<meta name="base-path" content="${base}" />`);
}

/** [webDir]: the built UI (npm run build); without it, only the API is served. */
export function dashboardRoutes(store: Store, config: Config, webDir?: string) {
  const base = config.basePath;
  const app = new Hono();
  // At the root whatever the base path, for the container's probes.
  app.get('/health', (c) => c.json({ ok: true, mode: config.mode }));

  const ui = new Hono();
  ui.route('/api', apiRoutes(store, config));
  if (webDir) {
    const root = path.relative(process.cwd(), webDir) || '.';
    const index = path.join(webDir, 'index.html');
    ui.use('/assets/*', serveStatic({ root, rewriteRequestPath: (p) => p.slice(base.length - 1) }));
    ui.get('*', (c) => c.html(indexHtml(readFileSync(index, 'utf8'), base))); // client-side routes
  }
  app.route(base === '/' ? '/' : base.slice(0, -1), ui);
  if (base !== '/') app.get('/', (c) => c.redirect(base));
  return app;
}
