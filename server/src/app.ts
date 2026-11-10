import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { getConfig } from './config.js';
import { mountAuth } from './auth/index.js';
import { csrfProtection, mountCsrf } from './auth/csrf.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { adminRouter } from './routes/admin.js';
import { photosRouter } from './routes/photos.js';
import { voteRouter } from './routes/vote.js';

export function createApp(): Express {
  const config = getConfig();   // throws (refuses to start) on AUTH_MODE=dev + NODE_ENV=production
  const app = express();
  app.disable('x-powered-by');

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
  mountCsrf(app, config);
  app.use('/api', csrfProtection(config));
  mountAuth(app, config);

  app.use('/api/campaigns', adminRouter());
  app.use('/api/vote', voteRouter());
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
