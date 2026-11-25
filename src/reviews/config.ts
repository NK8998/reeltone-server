import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { PoolConfig } from 'pg';

let local: NodeJS.ProcessEnv = {};
try {
  local = parseEnv(readFileSync(new URL('../../reviews/.env', import.meta.url), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export const reviewsEnv = (key: string) => process.env[key] ?? local[key];
const value = (key: string) => reviewsEnv(key)?.trim() || undefined;
const origin = (input: string) => {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an HTTP(S) origin without a path, query, or credentials');
  }
  return url.origin;
};

export const reviewsEnabled = reviewsEnv('REVIEWS_ENABLED') !== '0';

export function loadReviewsConfig() {
  const issuer = origin(value('AUTH_ISSUER') ?? 'http://localhost:3000');
  const internalIssuer = origin(value('AUTH_INTERNAL_URL') ?? issuer);
  const reviewsOrigin = origin(value('REVIEWS_ORIGIN') ?? 'http://localhost:3101');
  const production = (value('APP_ENV') ?? process.env.NODE_ENV) === 'production';
  const secret = reviewsEnv('REVIEWS_SESSION_SECRET');
  const tmdbKey = value('TMDB_API_KEY');
  if (reviewsEnabled && secret && secret.length < 32) throw new Error('REVIEWS_SESSION_SECRET must contain at least 32 characters');
  if (reviewsEnabled && production) {
    if (![issuer, internalIssuer, reviewsOrigin].every((url) => url.startsWith('https://'))) {
      throw new Error('Production Reviews and Auth must use HTTPS origins');
    }
    if (!tmdbKey) throw new Error('TMDB_API_KEY must be configured in production');
  }
  return {
    issuer, internalIssuer, origin: reviewsOrigin, production, secret, tmdbKey,
    clientId: value('AUTH_CLIENT_ID') ?? 'reviews-local',
    clientSecret: reviewsEnv('AUTH_CLIENT_SECRET'),
    adminIds: new Set((value('REVIEWS_ADMIN_IDS') ?? '').split(/\s+/)),
    imageBase: (value('TMDB_IMAGE_BASE_URL') ?? 'https://image.tmdb.org/t/p').replace(/\/+$/, ''),
  };
}

export function reviewsDatabaseConfig(migration = false): PoolConfig {
  const pg = (key: string) => process.env[`REVIEWS_${key}`] ?? (migration ? process.env[key] : undefined) ?? local[key];
  return {
    host: pg('PGHOST') || '127.0.0.1',
    port: Number(pg('PGPORT') || 5433),
    database: pg('PGDATABASE') || 'reeltone_reviews',
    user: pg('PGUSER') || 'reeltone_reviews',
    password: pg('PGPASSWORD'),
    options: '-c timezone=UTC',
    connectionTimeoutMillis: 5000,
  };
}
