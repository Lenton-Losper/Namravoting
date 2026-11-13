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
import { errorHandler, notFoundHandler } from './errors.js';
import { adminRouter } from './routes/admin.js';
import { nominateRouter } from './routes/nominate.js';
import { observeRouter } from './routes/team.js';
import { photosRouter } from './routes/photos.js';
import { voteRouter } from './routes/vote.js';

export function createApp(opts: { accessVerifier?: AccessVerifier; entra?: EntraOptions } = {}): Express {
  const config = getConfig();   // throws (refuses to start) on AUTH_MODE=dev + NODE_ENV=production
  const app = express();
  app.disable('x-powered-by');

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
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
