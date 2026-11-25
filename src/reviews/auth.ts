import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  BadRequestException, Controller, Get, HttpCode, Inject, Injectable, Post, Req, Res,
  ServiceUnavailableException, UnauthorizedException, BadGatewayException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';
import { loadReviewsConfig } from './config.js';
import { ReviewsDatabase } from './database.js';

const cookieName = 'reeltone_reviews';
const callbackPath = '/api/reeltone/auth/callback';
const now = () => Math.floor(Date.now() / 1000);
const tokenHash = (token: string | undefined) => token ? createHash('sha256').update(token).digest('hex') : null;
const token = () => randomBytes(32).toString('base64url');

export type Viewer = {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
};
type Attempt = { state: string; verifier: string; nonce: string; next: string; expires: number };
type Session = { token?: string; attempts?: Attempt[] };

function sameSignature(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function safeNext(value: unknown) {
  if (typeof value !== 'string' || value.length > 600 || !value.startsWith('/') ||
    value.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/me';
  return value;
}

@Injectable()
export class ReviewsAuth {
  readonly config = loadReviewsConfig();
  private provider?: Promise<oidc.Configuration>;
  private readonly viewers = new WeakMap<Request, Promise<Viewer | null>>();

  constructor(@Inject(ReviewsDatabase) private readonly db: ReviewsDatabase) {}

  private session(req: Request): Session {
    const secret = this.config.secret;
    const cookie = req.headers.cookie?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(cookieName + '='));
    if (!secret || !cookie || cookie.length > 4300) return {};
    const raw = cookie.slice(cookieName.length + 1);
    if (!/^[\w.-]+$/.test(raw)) return {};
    const signatureAt = raw.lastIndexOf('.');
    if (signatureAt < 0) return {};
    const data = raw.slice(0, signatureAt);
    const signature = raw.slice(signatureAt + 1);
    try {
      if (data.startsWith('v1.')) {
        const expected = createHmac('sha256', secret).update(data).digest('base64url');
        if (!sameSignature(signature, expected)) return {};
        return JSON.parse(Buffer.from(data.slice(3), 'base64url').toString()) as Session;
      }
      // Flask's signed cookie uses a timestamp and an optionally compressed payload.
      const key = createHmac('sha1', secret).update('cookie-session').digest();
      const expected = createHmac('sha1', key).update(data).digest('base64url');
      if (!sameSignature(signature, expected)) return {};
      const compressed = data.startsWith('.');
      const payload = Buffer.from(data.slice(compressed ? 1 : 0, data.lastIndexOf('.')), 'base64url');
      const legacy = JSON.parse((compressed ? inflateSync(payload, { maxOutputLength: 8192 }) : payload).toString());
      return typeof legacy.review_session === 'string' ? { token: legacy.review_session } : {};
    } catch {
      return {};
    }
  }

  private writeSession(res: Response, session: Session) {
    const options = { httpOnly: true, sameSite: 'lax' as const, secure: this.config.origin.startsWith('https:'), path: '/' };
    if (!session.token && !session.attempts?.length) {
      res.clearCookie(cookieName, options);
      return;
    }
    const data = 'v1.' + Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', this.config.secret!).update(data).digest('base64url');
    res.cookie(cookieName, data + '.' + signature, options);
  }

  viewer(req: Request): Promise<Viewer | null> {
    const existing = this.viewers.get(req);
    if (existing) return existing;
    const hash = tokenHash(this.session(req).token);
    const result = hash
      ? this.db.query<{ profile: string }>('SELECT profile FROM reviews_sessions WHERE token_hash = $1 AND expires_at > $2', [hash, now()])
        .then(({ rows }) => rows[0] ? JSON.parse(rows[0].profile) as Viewer : null)
      : Promise.resolve(null);
    this.viewers.set(req, result);
    return result;
  }

  async requireViewer(req: Request) {
    const viewer = await this.viewer(req);
    if (!viewer) throw new UnauthorizedException({ error: 'Sign in to Reviews' });
    return viewer;
  }

  private async discover() {
    const { issuer, internalIssuer, clientId, clientSecret, production } = this.config;
    const response = await fetch(internalIssuer + '/.well-known/openid-configuration', {
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw new Error('OIDC discovery failed');
    const discovered: oidc.ServerMetadata = await response.json();
    const metadata = { ...discovered };
    if (metadata.issuer !== issuer) throw new Error('OIDC issuer mismatch');
    const endpoints = {
      authorization_endpoint: issuer, token_endpoint: internalIssuer,
      jwks_uri: internalIssuer, userinfo_endpoint: internalIssuer,
    } as const;
    for (const key of Object.keys(endpoints) as (keyof typeof endpoints)[]) {
      const url = new URL(metadata[key] ?? '');
      if (![issuer, internalIssuer].includes(url.origin) || url.username || url.password || url.hash) {
        throw new Error('OIDC endpoint origin mismatch');
      }
      metadata[key] = endpoints[key] + url.pathname + url.search;
    }
    const provider = new oidc.Configuration(metadata, clientId, clientSecret, oidc.ClientSecretBasic(clientSecret!));
    if (!production) oidc.allowInsecureRequests(provider);
    oidc.enableNonRepudiationChecks(provider);
    return provider;
  }

  private client() {
    if (!this.config.secret || !this.config.clientSecret) {
      throw new ServiceUnavailableException('Reviews sign-in is not configured.');
    }
    return this.provider ??= this.discover().catch((error) => {
      this.provider = undefined;
      throw error;
    });
  }

  async login(req: Request, res: Response) {
    const provider = this.client();
    const session = this.session(req);
    const destination = req.query.next || (!this.config.tmdbKey ? '/members' : '/me');
    const attempt = {
      state: oidc.randomState(), verifier: oidc.randomPKCECodeVerifier(), nonce: oidc.randomNonce(),
      next: safeNext(destination), expires: now() + 600,
    };
    const attempts = (session.attempts ?? []).filter((entry) => entry.expires > now());
    const params: Record<string, string> = {
      redirect_uri: this.config.origin + callbackPath,
      scope: 'openid profile email',
      state: attempt.state, nonce: attempt.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier), code_challenge_method: 'S256',
    };
    if (req.query.mode === 'signup') params.login_hint = 'signup';
    let url: URL;
    try {
      url = oidc.buildAuthorizationUrl(await provider, params);
    } catch {
      throw new BadGatewayException('ReelTone Auth is temporarily unavailable.');
    }
    this.writeSession(res, { ...session, attempts: [...attempts.slice(-2), attempt] });
    res.redirect(302, url.href);
  }

  async callback(req: Request, res: Response) {
    const session = this.session(req);
    const attempt = session.attempts?.find((entry) => entry.state === req.query.state && entry.expires > now());
    if (!attempt) throw new BadRequestException('Sign-in expired. Start again from Reviews.');
    const remaining = { ...session, attempts: session.attempts?.filter((entry) => entry !== attempt) };
    let claims: Awaited<ReturnType<typeof oidc.fetchUserInfo>>;
    try {
      const provider = await this.client();
      const callback = new URL(this.config.origin + callbackPath);
      callback.search = new URL(req.originalUrl, this.config.origin).search;
      const grant = await oidc.authorizationCodeGrant(provider, callback, {
        pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce, idTokenExpected: true,
      });
      const subject = grant.claims()?.sub;
      if (!subject || !grant.access_token) throw new Error('Incomplete identity');
      claims = await oidc.fetchUserInfo(provider, grant.access_token, subject);
    } catch {
      this.writeSession(res, remaining);
      throw new BadRequestException('Sign-in could not finish. Start again from Reviews.');
    }
    if (claims.email_verified !== true || !claims.email || !claims.preferred_username ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(claims.sub)) {
      this.writeSession(res, remaining);
      throw new BadRequestException('A verified ReelTone account is required.');
    }
    const profile: Viewer = {
      id: claims.sub.toLowerCase(), username: claims.preferred_username,
      firstName: claims.given_name ?? null, lastName: claims.family_name ?? null, imageUrl: claims.picture ?? null,
    };
    const newToken = token();
    const time = now();
    await this.db.transaction(async (db) => {
      await db.query(`INSERT INTO members (user_id, username, email, pfp_url) VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email, pfp_url = EXCLUDED.pfp_url`,
      [profile.id, profile.username, claims.email, profile.imageUrl]);
      await db.query('DELETE FROM reviews_sessions WHERE expires_at <= $1 OR token_hash = $2', [time, tokenHash(session.token)]);
      await db.query('INSERT INTO reviews_sessions (token_hash, profile, expires_at) VALUES ($1, $2, $3)',
        [tokenHash(newToken), JSON.stringify(profile), time + 3600]);
    });
    this.writeSession(res, { token: newToken });
    res.redirect(303, attempt.next);
  }

  async logout(req: Request, res: Response) {
    const hash = tokenHash(this.session(req).token);
    if (hash) await this.db.query('DELETE FROM reviews_sessions WHERE token_hash = $1', [hash]);
    this.writeSession(res, {});
  }
}

@Controller('reviews/auth')
export class ReviewsAuthController {
  constructor(@Inject(ReviewsAuth) private readonly auth: ReviewsAuth) {}

  @Get('login')
  login(@Req() req: Request, @Res() res: Response) { return this.auth.login(req, res); }

  @Get('callback')
  callback(@Req() req: Request, @Res() res: Response) { return this.auth.callback(req, res); }

  @Get('session')
  async session(@Req() req: Request) { return { user: await this.auth.viewer(req) }; }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.auth.logout(req, res); }

  @Get('account')
  async account(@Req() req: Request, @Res() res: Response) {
    await this.auth.requireViewer(req);
    res.redirect(this.auth.config.issuer + '/account');
  }

  @Get('forgot-password')
  forgotPassword(@Res() res: Response) { res.redirect(this.auth.config.issuer + '/forgot-password'); }
}
