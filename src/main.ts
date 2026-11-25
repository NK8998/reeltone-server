import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { config } from './auth/config.js';
import { AuthModule } from './auth/module.js';
import { OidcService } from './auth/oidc.js';
import { loadReviewsConfig, reviewsEnabled } from './reviews/config.js';
import { ReviewsModule } from './reviews/module.js';
import { StreamingModule } from './streaming.js';

@Module({ imports: [AuthModule, StreamingModule, ...(reviewsEnabled ? [ReviewsModule] : [])] })
class AppModule {}

const server = express();
server.disable('x-powered-by');
if (config.trustProxy) server.set('trust proxy', 1);
server.use(helmet({
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.secure ? [] : null } },
  referrerPolicy: { policy: 'no-referrer' },
}));
const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { bodyParser: false });
app.enableShutdownHooks();

if (reviewsEnabled) {
  const reviews = loadReviewsConfig();
  const allowedOrigins = new Set([reviews.origin, 'https://reeltone.site', 'https://www.reeltone.site']);
  server.use('/reviews', (req, res, next) => {
    if (/^\/(auth|me|film|members)(\/|$)/.test(req.path)) res.set('Cache-Control', 'private, no-store');
    const origin = req.get('Origin');
    if (origin && (!reviews.production || allowedOrigins.has(origin))) {
      res.vary('Origin');
      res.set('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS' && req.get('Access-Control-Request-Method')) {
        res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.sendStatus(204);
        return;
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin !== reviews.origin) {
      res.status(403).json({ error: 'Invalid request origin' });
      return;
    }
    next();
  }, express.json({ limit: '100kb' }));
}

const protocol = app.get(OidcService).provider.callback();
const uiPaths = new Set(['/', '/readyz', '/account', '/forgot-password', '/reset', '/reset-link.js', '/continue.js']);
server.use((req, res, next) => {
  if (req.path === '/api/stream' || req.path.startsWith('/api/stream/') ||
      req.path === '/reviews' || req.path.startsWith('/reviews/')) {
    next();
    return;
  }
  if (uiPaths.has(req.path) || req.path.startsWith('/interaction/') || req.path.startsWith('/social/')) {
    res.set('Cache-Control', 'no-store');
    // Browsers send a null Origin on form POSTs from pages using no-referrer.
    res.set('Referrer-Policy', 'same-origin');
    next();
    return;
  }
  void protocol(req, res);
});
server.use(express.urlencoded({ limit: '12kb', parameterLimit: 20, extended: false }));
await app.listen(config.port, config.host);
