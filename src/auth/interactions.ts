import { BadRequestException, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Provider } from 'oidc-provider';
import { Accounts, field, FormError, newPassword, normalizeEmail, readProfile, type Form, type SocialIdentity } from './accounts.js';
import { config, digest } from './config.js';
import { Database } from './db.js';
import { OidcService } from './oidc.js';
import { SocialLogin } from './social.js';
import { codeInput, emailInput, escape, form, hidden, page, passwordInput, profileInputs } from './views.js';

type Interaction = Awaited<ReturnType<Provider['interactionDetails']>>;

function equals(left: string, right: string) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function body(req: Request): Form {
  if (!req.is('application/x-www-form-urlencoded') || !req.body || typeof req.body !== 'object') {
    throw new BadRequestException('Expected a form submission');
  }
  const origin = req.get('origin');
  if (origin && origin !== config.issuer) throw new BadRequestException('Invalid form origin');
  return req.body as Form;
}

function providerName(value: unknown) {
  if (value !== 'google' && value !== 'github') throw new BadRequestException('Unknown provider');
  return value;
}

function argument(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function message(error: unknown) {
  if (error instanceof FormError) return error.message;
  throw error;
}

function csrf(uid: string) { return digest('interaction', uid).toString('hex'); }
function signupPath(uid: string, attempt = '') {
  const path = `/interaction/${uid}/signup`;
  return attempt ? `${path}?${new URLSearchParams({ attempt })}` : path;
}
const standaloneCookie = config.secure ? '__Host-reeltone_form' : 'reeltone_form';

@Controller()
export class InteractionController {
  private readonly provider: Provider;

  constructor(@Inject(OidcService) oidc: OidcService, @Inject(Accounts) private readonly accounts: Accounts,
    @Inject(SocialLogin) private readonly social: SocialLogin, @Inject(Database) private readonly db: Database) {
    this.provider = oidc.provider;
  }

  @Get()
  home(@Res() res: Response) {
    const links = config.applications.map(({ name, url }) =>
      `<li><a href="${escape(url)}">${escape(name)}</a></li>`,
    ).join('');
    const apps = links ? `<h2>ReelTone apps</h2><ul>${links}</ul>` : '<p>No ReelTone apps are available yet.</p>';
    res.send(page('Your ReelTone account', apps
      + '<div class="links"><a href="/account">Manage profile</a><a href="/forgot-password">Reset your password</a></div>'));
  }

  @Get('account')
  async profile(@Req() req: Request, @Res() res: Response) {
    await this.accountView(req, res);
  }

  @Post('account')
  @HttpCode(200)
  async updateProfile(@Req() req: Request, @Res() res: Response) {
    const fields = body(req);
    await this.accountView(req, res, fields);
  }

  @Get('readyz')
  async ready(@Res() res: Response) {
    try {
      await this.db.query('SELECT 1 FROM accounts LIMIT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }

  @Get('interaction/:uid')
  async interaction(@Req() req: Request, @Res() res: Response) {
    const interaction = await this.load(req, res);
    if (interaction.prompt.name === 'consent') {
      await this.grant(req, res, interaction);
      return;
    }
    if (interaction.params.login_hint === 'signup' && req.query.mode !== 'login') {
      this.signupView(res, interaction.uid);
      return;
    }
    this.signinView(res, interaction.uid);
  }

  @Post('interaction/:uid/login')
  async login(@Req() req: Request, @Res() res: Response) {
    const { uid, formData } = await this.loginForm(req, res);
    try {
      const email = normalizeEmail(field(formData, 'email'));
      await this.accounts.limit('login-email', email, 10);
      const accountId = await this.accounts.authenticate(email, field(formData, 'password'));
      if (!accountId) throw new FormError('The email or password did not match.');
      await this.finish(req, res, accountId, 'pwd');
    } catch (error) {
      this.signinView(res.status(400), uid, message(error));
    }
  }

  @Get('interaction/:uid/signup')
  async signup(@Req() req: Request, @Res() res: Response) {
    const { uid } = await this.load(req, res, true);
    const attempt = argument(req.query.attempt);
    const identity = attempt ? await this.pendingSignup(res, uid, attempt) : undefined;
    if (attempt && !identity) return;
    this.signupView(res, uid, attempt, identity);
  }

  @Post('interaction/:uid/signup/code')
  @HttpCode(200)
  async requestCode(@Req() req: Request, @Res() res: Response) {
    const { uid, formData } = await this.loginForm(req, res);
    const attempt = field(formData, 'attempt');
    const identity = attempt ? await this.pendingSignup(res, uid, attempt) : undefined;
    if (attempt && !identity) return;
    try {
      const email = normalizeEmail(field(formData, 'email'));
      await this.accounts.limit('send-code', email, 4);
      const id = await this.accounts.sendVerification(email, uid);
      if (!id) {
        this.signupView(res.status(503), uid, attempt, identity, 'Could not send the verification code. Try again.');
        return;
      }
      this.verifyView(res, uid, id, attempt, identity);
    } catch (error) {
      this.signupView(res.status(400), uid, attempt, identity, message(error));
    }
  }

  @Post('interaction/:uid/signup/finish')
  async finishSignup(@Req() req: Request, @Res() res: Response) {
    const { uid, formData } = await this.loginForm(req, res);
    const attempt = field(formData, 'attempt');
    const id = field(formData, 'challenge');
    const identity = attempt ? await this.pendingSignup(res, uid, attempt) : undefined;
    if (attempt && !identity) return;
    try {
      const user = readProfile(formData);
      const code = field(formData, 'code');
      if (!/^\d{6}$/.test(code)) throw new FormError('Enter the six-digit code from your email.');
      const accountId = await this.accounts.create(uid, id, code, user, identity
        ? { identity, attempt }
        : { password: newPassword(field(formData, 'password')) });
      if (!accountId) throw new FormError('The verification code is incorrect or expired.');
      await this.finish(req, res, accountId, identity ? 'federated' : 'pwd');
    } catch (error) {
      this.verifyView(res.status(400), uid, id, attempt, identity, message(error));
    }
  }

  @Post('interaction/:uid/social/:provider')
  async startSocial(@Req() req: Request, @Res() res: Response) {
    const { uid } = await this.loginForm(req, res);
    const provider = providerName(req.params.provider);
    try {
      const url = await this.social.start(provider, uid);
      // End the form navigation before leaving Auth so form-action can stay self-only.
      const name = provider === 'google' ? 'Google' : 'GitHub';
      this.continueView(res, `Continue to ${name}`, url);
    } catch (error) {
      if (!(error instanceof FormError)) console.error('Could not start a social sign-in');
      this.signinView(res.status(400), uid, 'Could not start social sign-in. Try again.');
    }
  }

  @Get('continue.js')
  continueScript(@Res() res: Response) {
    res.type('application/javascript').send("const link = document.getElementById('continue-link'); if (link) location.replace(link.href);");
  }

  @Get('social/:provider/callback')
  async socialCallback(@Req() req: Request, @Res() res: Response) {
    const provider = providerName(req.params.provider);
    if (req.query.state === undefined) {
      res.redirect(303, '/');
      return;
    }
    const state = argument(req.query.state);
    try {
      const attempt = await this.social.callbackAttempt(provider, state);
      if (attempt.signup_pending) {
        res.redirect(303, signupPath(attempt.interaction_id, attempt.id));
        return;
      }
      if (attempt.consumed) throw new FormError('This social sign-in link has already been used.');
      const query = new URLSearchParams({ state });
      for (const key of ['code', 'error', 'iss']) {
        const value = argument(req.query[key]);
        if (value) query.set(key, value);
      }
      // The interaction cookie is scoped to this path.
      res.redirect(303, `/interaction/${attempt.interaction_id}/social/${provider}/return?${query}`);
    } catch (error) {
      res.status(400).send(page('Could not continue sign-in', '<p>Return to your ReelTone app to try again.</p>', message(error)));
    }
  }

  @Get('interaction/:uid/social/:provider/return')
  async returnSocial(@Req() req: Request, @Res() res: Response) {
    const { uid } = await this.load(req, res, true);
    const provider = providerName(req.params.provider);
    const callback = new URL(`/social/${provider}/callback`, config.issuer);
    callback.search = new URL(req.originalUrl, config.issuer).search;
    try {
      const result = await this.social.complete(provider, uid, callback);
      if (result.signup === undefined) {
        await this.finish(req, res, result.account, 'federated');
      } else {
        res.redirect(303, signupPath(uid, result.signup));
      }
    } catch (error) {
      this.signinView(res.status(400), uid, message(error));
    }
  }

  @Get('forgot-password')
  forgotPassword(@Res() res: Response) {
    const contents = form('/forgot-password', this.issueFormToken(res), emailInput(), 'Send reset link');
    res.send(page('Reset your password', contents));
  }

  @Post('forgot-password')
  @HttpCode(200)
  async sendReset(@Req() req: Request, @Res() res: Response) {
    const formData = this.standaloneForm(req);
    await this.accounts.limit('reset-ip', req.ip ?? 'unknown', 30);
    let email: string;
    try {
      email = normalizeEmail(field(formData, 'email'));
    } catch (error) {
      res.status(400).send(page('Reset your password',
        form('/forgot-password', field(formData, 'csrf'), emailInput(), 'Send reset link'), message(error)));
      return;
    }
    await this.accounts.limit('reset-email', email, 4);
    await this.accounts.requestReset(email);
    res.send(page('Check your email', '<p>If that address has a password account, we sent a reset link.</p>'));
  }

  @Get('reset-link.js')
  resetScript(@Res() res: Response) {
    res.type('application/javascript').send(`const fragment = location.hash.slice(1);
      if (fragment) {
        document.querySelector('input[name=token]').value = fragment;
        history.replaceState(null, '', location.pathname);
      }`);
  }

  @Get('reset')
  resetPage(@Res() res: Response) { this.resetView(res, this.issueFormToken(res)); }

  @Post('reset')
  @HttpCode(200)
  async resetPassword(@Req() req: Request, @Res() res: Response) {
    const formData = this.standaloneForm(req);
    await this.accounts.limit('reset-submit', req.ip ?? 'unknown', 15);
    try {
      const valid = await this.accounts.reset(field(formData, 'token'), newPassword(field(formData, 'password')));
      if (!valid) throw new FormError('This link is invalid, expired, or already used.');
      res.clearCookie(standaloneCookie, { path: '/', httpOnly: true, secure: config.secure, sameSite: 'lax' });
      res.send(page('Password updated', '<p>Return to your ReelTone app and sign in with your new password.</p>'));
    } catch (error) {
      this.resetView(res.status(400), field(formData, 'csrf'), field(formData, 'token'), message(error));
    }
  }

  private async load(req: Request, res: Response, login = false) {
    let interaction: Interaction;
    try { interaction = await this.provider.interactionDetails(req, res); } catch {
      throw new BadRequestException('Sign-in expired. Return to your ReelTone app and try again.');
    }
    if (req.params.uid !== interaction.uid || (login && interaction.prompt.name !== 'login')) {
      throw new BadRequestException('Invalid sign-in request');
    }
    return interaction;
  }

  private async loginForm(req: Request, res: Response) {
    const { uid } = await this.load(req, res, true);
    const formData = body(req);
    if (!/^[a-f0-9]{64}$/.test(field(formData, 'csrf')) || !equals(field(formData, 'csrf'), csrf(uid))) {
      throw new BadRequestException('Invalid form token');
    }
    await this.accounts.limit('interaction-ip', req.ip ?? 'unknown', 90);
    return { uid, formData };
  }

  private async pendingSignup(res: Response, uid: string, attempt: string) {
    const identity = await this.social.pending(attempt, uid);
    if (!identity) this.signinView(res.status(400), uid, 'This social sign-up is no longer available. Sign in again to continue.');
    return identity;
  }

  private issueFormToken(res: Response) {
    const nonce = randomBytes(32).toString('hex');
    res.cookie(standaloneCookie, nonce, { httpOnly: true, sameSite: 'lax', secure: config.secure, path: '/', maxAge: 30 * 60 * 1000 });
    return digest('recovery-form', nonce).toString('hex');
  }

  private standaloneForm(req: Request) {
    const formData = body(req);
    const nonce = (req.get('cookie') ?? '').split('; ').find((pair) => pair.startsWith(`${standaloneCookie}=`))?.split('=')[1];
    const token = field(formData, 'csrf');
    if (!nonce || !/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(token) ||
      !equals(token, digest('recovery-form', nonce).toString('hex'))) throw new BadRequestException('Invalid form token');
    return formData;
  }

  private async finish(req: Request, res: Response, accountId: string, amr: string) {
    const url = await this.provider.interactionResult(req, res, { login: { accountId, amr: [amr] } }, { mergeWithLastSubmission: false });
    if (req.method === 'GET') {
      res.redirect(303, url);
      return;
    }
    this.continueView(res, 'Continue signing in', url);
  }

  private continueView(res: Response, title: string, url: string) {
    res.status(200).send(page(title,
      `<a id="continue-link" href="${escape(url)}">${escape(title)}</a><script src="/continue.js" defer></script>`));
  }

  private async grant(req: Request, res: Response, interaction: Interaction) {
    const clientId = argument(interaction.params.client_id);
    const accountId = interaction.session?.accountId;
    if (!accountId || !config.clients.some((client) => client.client_id === clientId)) {
      throw new BadRequestException('Invalid application session');
    }
    const prior = (interaction as Interaction & { grantId?: string }).grantId;
    const grant = (prior ? await this.provider.Grant.find(prior) : undefined)
      ?? new this.provider.Grant({ clientId, accountId });
    const details = interaction.prompt.details;
    if (Array.isArray(details.missingOIDCScope)) grant.addOIDCScope(details.missingOIDCScope.join(' '));
    if (Array.isArray(details.missingOIDCClaims)) grant.addOIDCClaims(details.missingOIDCClaims);
    await this.provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
  }

  private async accountView(req: Request, res: Response, fields?: Form) {
    const context = this.provider.createContext(req, res);
    const session = await this.provider.Session.get(context);
    const id = session.accountId;
    let profile = id ? await this.accounts.profile(id) : undefined;
    if (!id || !profile) {
      res.status(401).send(page('Sign in to manage your account', '<p>Open a ReelTone app and sign in first.</p>'));
      return;
    }
    const token = digest('account-form', session.uid).toString('hex');
    let errorText: string | undefined;
    let saved = false;
    if (fields) {
      const submitted = field(fields, 'csrf');
      if (!/^[a-f0-9]{64}$/.test(submitted) || !equals(submitted, token)) throw new BadRequestException('Invalid form token');
      await this.accounts.limit('profile-write', id, 20);
      try {
        profile = readProfile(fields);
        await this.accounts.updateProfile(id, profile);
        saved = true;
      } catch (error) {
        errorText = message(error);
        res.status(400);
      }
    }
    res.send(page('Your profile', (saved ? '<p role="status">Profile updated.</p>' : '')
      + form('/account', token, profileInputs(profile), 'Save profile'), errorText));
  }

  private signinView(res: Response, uid: string, error?: string) {
    const path = `/interaction/${uid}`;
    const social = (['google', 'github'] as const).filter((name) => config[name]).map((name) =>
      form(`${path}/social/${name}`, csrf(uid), '', `Continue with ${name === 'google' ? 'Google' : 'GitHub'}`, true),
    ).join('');
    res.send(page('Sign in', form(`${path}/login`, csrf(uid), emailInput() + passwordInput(true), 'Sign in') + social
      + `<div class="links"><a href="${path}/signup">Create an account</a><a href="/forgot-password">Forgot password</a></div>`, error));
  }

  private signupView(res: Response, uid: string, attempt = '', identity?: SocialIdentity, error?: string) {
    const path = `/interaction/${uid}`;
    res.send(page('Create your account', form(`${path}/signup/code`, csrf(uid), emailInput(identity?.email)
      + hidden('attempt', attempt), 'Send verification code') + `<a href="${path}?mode=login">Back to sign in</a>`, error));
  }

  private verifyView(res: Response, uid: string, id: string, attempt: string, identity?: SocialIdentity, error?: string) {
    const path = `/interaction/${uid}`;
    res.send(page('Verify your email and finish sign-up', form(`${path}/signup/finish`, csrf(uid),
      hidden('challenge', id) + hidden('attempt', attempt) + codeInput + profileInputs(identity)
      + (attempt ? '' : passwordInput()), 'Create account') + `<a href="${signupPath(uid, attempt)}">Start over</a>`, error));
  }

  private resetView(res: Response, token: string, resetToken = '', error?: string) {
    res.send(page('Choose a new password', form('/reset', token, hidden('token', resetToken) + passwordInput(), 'Update password')
      + '<script src="/reset-link.js" defer></script><a href="/forgot-password">Request another reset link</a>', error));
  }
}
