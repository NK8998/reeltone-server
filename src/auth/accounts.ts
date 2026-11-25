import { HttpException, Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify } from 'argon2';
import type { PoolClient } from 'pg';
import nodemailer from 'nodemailer';
import { config, digest } from './config.js';
import { Database } from './db.js';

export type Form = Record<string, unknown>;
export type SocialProvider = 'google' | 'github';
export type SocialIdentity = {
  provider: SocialProvider; id: string; username?: string; displayName?: string;
  firstName?: string; lastName?: string; email?: string; emailVerified: boolean; picture?: string;
};
export type Profile = { username: string; firstName: string; lastName: string; picture: string };
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class FormError extends Error {}

export function field(body: Form, name: string) {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new FormError('Enter a valid email address.');
  }
  return email;
}

export function newPassword(value: string) {
  if ([...value].length < 15 || Buffer.byteLength(value) > 512) {
    throw new FormError('Use a password of at least 15 characters and at most 512 bytes.');
  }
  return value;
}

export function readProfile(body: Form): Profile {
  const username = field(body, 'username').trim();
  const firstName = field(body, 'firstName').trim();
  const lastName = field(body, 'lastName').trim();
  const picture = field(body, 'picture').trim();
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    throw new FormError('Use 3–30 letters, numbers, or underscores for your username.');
  }
  if (firstName.length > 100 || lastName.length > 100) throw new FormError('Names can be up to 100 characters.');
  if (picture) {
    let url: URL | undefined;
    try { url = new URL(picture); } catch {}
    if (picture.length > 2048 || url?.protocol !== 'https:' || url.username || url.password) {
      throw new FormError('Enter an HTTPS profile picture URL.');
    }
  }
  return { username, firstName, lastName, picture };
}

@Injectable()
export class Mailer {
  private readonly smtp = config.smtp ? nodemailer.createTransport(config.smtp) : undefined;

  async deliver(email: string, subject: string, text: string) {
    if (!this.smtp) {
      console.log(`[local email] ${email} | ${subject} | ${text}`);
      return true;
    }
    try {
      await this.smtp.sendMail({ from: config.mailFrom, to: { name: '', address: email }, subject, text });
      return true;
    } catch (error) {
      const responseCode = typeof error === 'object' && error !== null && 'responseCode' in error
        && Number.isInteger(error.responseCode) ? ` (SMTP ${error.responseCode})` : '';
      console.error(`Could not deliver an authentication email${responseCode}`);
      return false;
    }
  }
}

type Challenge = {
  id: string;
  email: string;
  account_email_id: string | null;
  secret_digest: Buffer;
};

@Injectable()
export class Accounts implements OnModuleInit, OnApplicationShutdown {
  private readonly dummyHash = hash(randomBytes(32));
  private cleanup?: NodeJS.Timeout;

  constructor(@Inject(Database) private readonly db: Database, @Inject(Mailer) private readonly mail: Mailer) {}

  onModuleInit() {
    this.cleanup = setInterval(() => {
      void this.db.query(`
        DELETE FROM auth_rate_limits WHERE expires_at < now();
        DELETE FROM email_challenges WHERE expires_at < now();
        DELETE FROM oauth_login_attempts WHERE expires_at < now();
        DELETE FROM oidc_artifacts WHERE expires_at < now();
      `).catch(() => console.error('Could not remove expired authentication records'));
    }, 60 * 60 * 1000).unref();
  }

  onApplicationShutdown() { clearInterval(this.cleanup); }

  async limit(scope: string, identity: string, limit: number) {
    const { rows: [row] } = await this.db.query<{ hits: number }>(
      `INSERT INTO auth_rate_limits (key, hits, expires_at) VALUES ($1, 1, now() + interval '15 minutes')
       ON CONFLICT (key) DO UPDATE SET hits = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1
         ELSE auth_rate_limits.hits + 1 END, expires_at = CASE WHEN auth_rate_limits.expires_at <= now()
         THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END RETURNING hits`,
      [digest(`rate:${scope}`, identity)],
    );
    if (row.hits > limit) throw new HttpException('Too many requests. Try again in a few minutes.', 429);
  }

  async authenticate(email: string, password: string) {
    if (Buffer.byteLength(password) > 512) return;
    const { rows: [row] } = await this.db.query<{ id: string; password_hash: string }>(
      `SELECT a.id, p.password_hash FROM account_emails e
       JOIN accounts a ON a.id = e.account_id JOIN password_credentials p ON p.account_id = a.id
       WHERE e.normalized_email = $1 AND e.verified_at IS NOT NULL AND a.status = 'active'`,
      [email],
    );
    const valid = await verify(row?.password_hash ?? await this.dummyHash, password);
    if (valid && row) return row.id;
  }

  async profile(id: string) {
    const { rows: [profile] } = await this.db.query<Profile>(
      `SELECT username, COALESCE(first_name, '') AS "firstName", COALESCE(last_name, '') AS "lastName",
       COALESCE(profile_picture_url, '') AS picture FROM accounts WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return profile;
  }

  async updateProfile(id: string, profile: Profile) {
    try {
      const update = await this.db.query(
        `UPDATE accounts SET username = $2, first_name = $3, last_name = $4, profile_picture_url = $5, updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [id, profile.username, profile.firstName || null, profile.lastName || null, profile.picture || null],
      );
      if (!update.rowCount) throw new FormError('This account is unavailable.');
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        throw new FormError('That username is unavailable.');
      }
      throw error;
    }
  }

  async sendVerification(email: string, interaction: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = await this.makeChallenge('verify', email, code, interaction);
    const sent = await this.mail.deliver(email, 'Verify your ReelTone email',
      `Your ReelTone verification code is ${code}. It expires in 10 minutes.`);
    if (sent) return id;
    await this.db.query('DELETE FROM email_challenges WHERE id = $1', [id])
      .catch(() => console.error('Could not remove an undelivered email challenge'));
  }

  async requestReset(email: string) {
    const { rows: [row] } = await this.db.query<{ id: string }>(
      `SELECT e.id FROM account_emails e JOIN accounts a ON a.id = e.account_id
       JOIN password_credentials p ON p.account_id = a.id
       WHERE e.normalized_email = $1 AND e.verified_at IS NOT NULL AND a.status = 'active'`,
      [email],
    );
    if (!row) return;
    const secret = randomBytes(32).toString('base64url');
    const id = await this.makeChallenge('reset', email, secret, null, row.id);
    void this.mail.deliver(email, 'Reset your ReelTone password', `Open ${config.issuer}/reset#${id}.${secret} to reset your ReelTone password. The link expires in 20 minutes.`);
  }

  private async makeChallenge(purpose: 'verify' | 'reset', email: string, secret: string,
    interaction: string | null, accountEmail?: string) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO email_challenges (id, account_email_id, email, purpose, interaction_id, secret_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7::integer * interval '1 minute')`,
      [id, accountEmail, email, purpose, interaction, digest(purpose, `${id}:${secret}`), purpose === 'verify' ? 10 : 20],
    );
    return id;
  }

  private async useChallenge(client: PoolClient, purpose: 'verify' | 'reset', id: string, secret: string,
    interaction: string | null): Promise<Challenge | undefined> {
    if (!uuidPattern.test(id)) return;
    const { rows: [row] } = await client.query<Challenge>(
      `SELECT id, email, account_email_id, secret_digest FROM email_challenges
       WHERE id = $1 AND purpose = $2 AND interaction_id IS NOT DISTINCT FROM $3
       AND consumed_at IS NULL AND expires_at > now() AND attempt_count < 5 FOR UPDATE`,
      [id, purpose, interaction],
    );
    if (!row) return;
    if (!timingSafeEqual(row.secret_digest, digest(purpose, `${id}:${secret}`))) {
      await client.query('UPDATE email_challenges SET attempt_count = attempt_count + 1 WHERE id = $1', [id]);
      return;
    }
    await client.query('UPDATE email_challenges SET consumed_at = now() WHERE id = $1', [id]);
    return row;
  }

  async create(interaction: string, challenge: string, code: string, profile: Profile,
    method: { password: string } | { identity: SocialIdentity; attempt: string }) {
    const passwordHash = 'password' in method ? await hash(method.password) : undefined;
    try {
      return await this.db.transaction(async (client) => {
        const verified = await this.useChallenge(client, 'verify', challenge, code, interaction);
        if (!verified) return;
        const { rows: [account] } = await client.query<{ id: string }>(
          `INSERT INTO accounts (username, first_name, last_name, profile_picture_url)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [profile.username, profile.firstName || null, profile.lastName || null, profile.picture || null],
        );
        await client.query(
          `INSERT INTO account_emails (account_id, email, normalized_email, verified_at, is_primary)
           VALUES ($1, $2, $2, now(), true)`,
          [account.id, verified.email],
        );
        if ('identity' in method) {
          const attempt = await client.query(
            `DELETE FROM oauth_login_attempts WHERE id = $1 AND interaction_id = $2
             AND identity IS NOT NULL AND expires_at > now()`, [method.attempt, interaction],
          );
          if (!attempt.rowCount) throw new FormError('Start your social sign-up again.');
          const identity = method.identity;
          await client.query(
            `INSERT INTO oauth_identities (account_id, provider, provider_user_id, provider_username,
             provider_display_name, provider_first_name, provider_last_name, provider_email,
             provider_email_verified, provider_picture_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [account.id, identity.provider, identity.id, identity.username, identity.displayName, identity.firstName,
              identity.lastName, identity.email, identity.emailVerified, identity.picture],
          );
        } else {
          await client.query('INSERT INTO password_credentials VALUES ($1, $2, now())', [account.id, passwordHash]);
        }
        return account.id;
      });
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        if ('constraint' in error && error.constraint === 'accounts_username_unique') {
          throw new FormError('That username is unavailable.');
        }
        throw new FormError('An account already exists. Use its original sign-in method or reset your password.');
      }
      throw error;
    }
  }

  async reset(token: string, password: string) {
    const [id, secret, extra] = token.split('.');
    if (!id || !secret || extra || !/^[\w-]{43}$/.test(secret)) return false;
    const passwordHash = await hash(password);
    return this.db.transaction(async (client) => {
      // Lock the account first to serialize multiple reset links for the same user.
      const { rows: [account] } = await client.query<{ id: string }>(
        `SELECT a.id FROM accounts a JOIN account_emails e ON e.account_id = a.id
         JOIN email_challenges c ON c.account_email_id = e.id
         WHERE c.id = $1 AND a.status = 'active' FOR UPDATE OF a`,
        [uuidPattern.test(id) ? id : null],
      );
      if (!account || !await this.useChallenge(client, 'reset', id, secret, null)) return false;
      await client.query('UPDATE password_credentials SET password_hash = $2, changed_at = now() WHERE account_id = $1',
        [account.id, passwordHash]);
      await client.query(
        `UPDATE email_challenges SET consumed_at = now() WHERE purpose = 'reset' AND consumed_at IS NULL
         AND account_email_id IN (SELECT id FROM account_emails WHERE account_id = $1)`,
        [account.id],
      );
      await client.query(
        `WITH grants AS (SELECT id FROM oidc_artifacts WHERE model = 'Grant' AND payload->>'accountId' = $1)
         DELETE FROM oidc_artifacts WHERE payload->>'accountId' = $1 OR grant_id IN (SELECT id FROM grants)`,
        [account.id],
      );
      return true;
    });
  }
}
