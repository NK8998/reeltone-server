import { Inject, Injectable } from '@nestjs/common';
import * as oauth from 'openid-client';
import { type SocialIdentity, type SocialProvider, uuidPattern, FormError } from './accounts.js';
import { config, digest } from './config.js';
import { Database } from './db.js';

type Attempt = { id: string; pkce_verifier: string; nonce: string | null };

@Injectable()
export class SocialLogin {
  private googleConfig?: Promise<oauth.Configuration>;

  constructor(@Inject(Database) private readonly db: Database) {}

  private google() {
    const credentials = config.google;
    if (!credentials) throw new FormError('Google sign-in is unavailable.');
    return this.googleConfig ??= oauth.discovery(new URL('https://accounts.google.com'), credentials.id, credentials.secret, undefined,
      { execute: [oauth.enableNonRepudiationChecks], timeout: 10 })
      .catch((error: unknown) => {
        this.googleConfig = undefined;
        throw error;
      });
  }

  private callback(provider: SocialProvider) {
    return `${config.issuer}/social/${provider}/callback`;
  }

  async callbackAttempt(provider: SocialProvider, state: string) {
    const invalid = 'This social sign-in link is invalid or has expired.';
    if (!state || state.length > 200 || !config[provider]) throw new FormError(invalid);
    const { rows: [attempt] } = await this.db.query<{
      id: string; interaction_id: string; consumed: boolean; signup_pending: boolean;
    }>(
      `SELECT id, interaction_id, consumed_at IS NOT NULL AS consumed, identity IS NOT NULL AS signup_pending
       FROM oauth_login_attempts WHERE provider = $1 AND state_digest = $2 AND expires_at > now()`,
      [provider, digest('oauth', state)],
    );
    if (!attempt) throw new FormError(invalid);
    return attempt;
  }

  async start(provider: SocialProvider, interaction: string) {
    if (!config[provider]) throw new FormError('This sign-in provider is unavailable.');
    const state = oauth.randomState();
    const verifier = oauth.randomPKCECodeVerifier();
    const nonce = provider === 'google' ? oauth.randomNonce() : null;
    const params = {
      redirect_uri: this.callback(provider),
      state,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    };
    const url = provider === 'google'
      ? oauth.buildAuthorizationUrl(await this.google(), { ...params, scope: 'openid email profile', nonce: nonce! })
      : new URL(`https://github.com/login/oauth/authorize?${new URLSearchParams({
        ...params, client_id: config.github!.id, scope: 'user:email',
      })}`);
    await this.db.query(
      `INSERT INTO oauth_login_attempts (provider, interaction_id, state_digest, pkce_verifier, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [provider, interaction, digest('oauth', state), verifier, nonce],
    );
    return url.href;
  }

  async complete(provider: SocialProvider, interaction: string, callback: URL) {
    const state = callback.searchParams.get('state');
    if (!state || state.length > 200 || !config[provider]) throw new FormError('Restart social sign-in.');
    const { rows: [attempt] } = await this.db.query<Attempt>(
      `UPDATE oauth_login_attempts SET consumed_at = now() WHERE provider = $1 AND interaction_id = $2
       AND state_digest = $3 AND consumed_at IS NULL AND expires_at > now() RETURNING id, pkce_verifier, nonce`,
      [provider, interaction, digest('oauth', state)],
    );
    if (!attempt) {
      const previous = await this.callbackAttempt(provider, state);
      if (previous.interaction_id === interaction && previous.signup_pending) return { signup: previous.id };
      throw new FormError('This social sign-in link has already been used. Start again.');
    }
    if (callback.searchParams.has('error')) throw new FormError('Social sign-in was cancelled. You can try again.');
    let identity: SocialIdentity;
    try {
      identity = provider === 'google'
        ? await this.googleIdentity(callback, attempt, state)
        : await this.githubIdentity(callback, attempt);
    } catch {
      throw new FormError('The provider could not complete sign-in. Try again.');
    }
    const { rows: [existing] } = await this.db.query<{ account_id: string; status: string }>(
      `SELECT i.account_id, a.status FROM oauth_identities i JOIN accounts a ON i.account_id = a.id
       WHERE i.provider = $1 AND i.provider_user_id = $2`, [provider, identity.id],
    );
    if (existing) {
      if (existing.status !== 'active') throw new FormError('This account is unavailable.');
      await this.db.query(
        'UPDATE oauth_identities SET last_login_at = now() WHERE provider = $1 AND provider_user_id = $2', [provider, identity.id],
      );
      return { account: existing.account_id };
    }

    await this.db.query('UPDATE oauth_login_attempts SET identity = $1 WHERE id = $2', [identity, attempt.id]);
    return { signup: attempt.id };
  }

  async pending(id: string, interaction: string) {
    if (!uuidPattern.test(id)) return;
    const { rows: [row] } = await this.db.query<{ identity: SocialIdentity }>(
      `SELECT identity FROM oauth_login_attempts WHERE id = $1 AND interaction_id = $2
       AND identity IS NOT NULL AND expires_at > now()`, [id, interaction],
    );
    return row?.identity;
  }

  private async googleIdentity(callback: URL, attempt: Attempt, state: string): Promise<SocialIdentity> {
    const token = await oauth.authorizationCodeGrant(await this.google(), callback, {
      pkceCodeVerifier: attempt.pkce_verifier,
      expectedState: state,
      expectedNonce: attempt.nonce!,
    });
    const claims = token.claims();
    if (!claims?.sub) throw new Error('Google response lacks a subject');
    return {
      provider: 'google', id: claims.sub,
      displayName: profileText(claims.name), firstName: profileText(claims.given_name),
      lastName: profileText(claims.family_name), picture: profileText(claims.picture, 2048),
      email: profileText(claims.email, 254), emailVerified: claims.email_verified === true,
    };
  }

  private async githubIdentity(callback: URL, attempt: Attempt): Promise<SocialIdentity> {
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('GitHub response lacks an authorization code');
    const credentials = config.github!;
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        client_id: credentials.id, client_secret: credentials.secret, code,
        redirect_uri: this.callback('github'), code_verifier: attempt.pkce_verifier,
      }),
    });
    if (!tokenResponse.ok) throw new Error('GitHub could not exchange the code');
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== 'string') throw new Error('GitHub response lacks an access token');
    const [user, emails] = await Promise.all([
      this.githubApi<{ id: number; login?: string; name?: string; avatar_url?: string; email?: string }>('/user', token.access_token),
      this.githubApi<{ email: string; verified: boolean; primary: boolean }[]>('/user/emails', token.access_token, true),
    ]);
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('GitHub response lacks a user ID');
    const verified = emails?.find((entry) => entry.verified && entry.primary) ?? emails?.find((entry) => entry.verified);
    return {
      provider: 'github', id: String(user.id),
      username: profileText(user.login), displayName: profileText(user.name), picture: profileText(user.avatar_url, 2048),
      email: profileText(verified?.email ?? user.email, 254), emailVerified: Boolean(verified),
    };
  }

  private async githubApi<T>(path: '/user' | '/user/emails', token: string, optional = false): Promise<T | undefined> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (optional && [403, 404].includes(response.status)) return;
    if (!response.ok) throw new Error('GitHub API could not supply the account data');
    return await response.json() as T;
  }
}

function profileText(value: unknown, limit = 100) {
  return typeof value === 'string' && value.length <= limit ? value : undefined;
}
