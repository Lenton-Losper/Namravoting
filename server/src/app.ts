import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { getConfig } from './config.js';
import { accessGate, createAccessVerifier, type AccessVerifier } from './auth/access.js';
import { mountAuth } from './auth/index.js';
import { authLimiter, csrfLimiter } from './auth/limits.js';
import { sessionLoader } from './auth/sessions.js';
import type { EntraOptions } from './auth/entra.js';
import { csrfProtection, mountCsrf } from './auth/csrf.js';
import { getPool } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { adminRouter } from './routes/admin.js';
import { nominateRouter } from './routes/nominate.js';
import { observeRouter } from './routes/team.js';
import { photosRouter } from './routes/photos.js';
import { voteRouter } from './routes/vote.js';

/** The base path the built client was compiled for (read from its index.html asset URLs): '' = the root. null = nothing built here. */
export function builtClientBase(distDir: string): string | null {
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) return null;
  const m = /(?:src|href)="([^"]*)\/assets\//.exec(fs.readFileSync(index, 'utf8'));
  return m ? m[1] : null;
}

export function createApp(opts: { accessVerifier?: AccessVerifier; entra?: EntraOptions; clientDist?: string } = {}): Express {
  const config = getConfig();   // throws (refuses to start) on AUTH_MODE=dev + NODE_ENV=production
  const inner = createInnerApp(opts);
  if (!config.basePath) return inner;
  // Served under a path (BASE_PATH=/voting-app): the reverse proxy forwards the path unchanged, so everything lives below it.
  const root = express();
  root.disable('x-powered-by');
  root.use(config.basePath, inner);
  root.get('/', (_req, res) => res.redirect(config.basePath + '/'));
  return root;
}

function createInnerApp(opts: { accessVerifier?: AccessVerifier; entra?: EntraOptions; clientDist?: string }): Express {
  const config = getConfig();
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  // Demo mode: the Cloudflare Access gate is the very first middleware, ahead of helmet, static files and every route.
  if (config.access) app.use(accessGate(opts.accessVerifier ?? createAccessVerifier(config.access)));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
        formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: config.isProd,
  }));   // helmet also sets X-Content-Type-Options: nosniff

  // Health check for the load balancer / Docker: no sign-in, no cookies. 200 only when the database answers.
  app.get('/api/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await getPool().query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use(express.json({ limit: '100kb' }));
  app.use('/auth', authLimiter(config));          // SEC-08: sign-in endpoints are throttled per client address
  app.use('/api/csrf', csrfLimiter(config));
  if (config.authMode !== 'demo') app.use(['/api', '/auth'], sessionLoader(config));   // server-side sessions (SEC-06)
  mountCsrf(app, config);
  app.use('/api', csrfProtection(config));
  mountAuth(app, config, opts.entra);

  app.use('/api/campaigns', adminRouter());
  app.use('/api/vote', voteRouter());
  app.use('/api/nominate', nominateRouter());
  app.use('/api/observe', observeRouter());
  app.use('/api/photos', photosRouter());
  app.use('/api', notFoundHandler);

  // Production: serve the built SPA (client/dist) with history fallback.
  const dist = opts.clientDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    // The client is compiled for one base path (Vite bakes it into every asset URL). Fail loudly if it is not this one.
    const built = builtClientBase(dist);
    if (built !== null && built !== config.basePath) {
      throw new Error(`Refusing to start: BASE_PATH is "${config.basePath}" but client/dist was built for "${built}". Rebuild the client with the same BASE_PATH (see HOSTING.md)`);
    }
    app.use(express.static(dist, { index: false }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
