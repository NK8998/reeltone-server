import { createServer } from 'node:http';
import * as oidc from 'openid-client';

const origin = 'http://localhost:3100';
const callback = `${origin}/callback`;
const issuer = new URL(process.env.AUTH_ISSUER ?? 'http://localhost:3000');
if (!['127.0.0.1', 'localhost'].includes(issuer.hostname)) throw new Error('The preview requires a local Auth issuer');
const config = await oidc.discovery(issuer, 'local', { token_endpoint_auth_method: 'none' }, oidc.None(), {
  execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks],
});
const attempts = new Map();

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(origin);
  const incoming = new URL(req.url, origin);
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  try {
    switch (url.pathname) {
      case '/': {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>ReelTone Auth preview</title><h1>ReelTone Auth preview</h1><a href="/login">Continue to ReelTone Auth</a></html>');
        break;
      }
      case '/login': {
        for (const [key, item] of attempts) {
          if (item.expires < Date.now()) attempts.delete(key);
        }
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const verifier = oidc.randomPKCECodeVerifier();
        attempts.set(state, { nonce, verifier, expires: Date.now() + 10 * 60 * 1000 });
        const destination = oidc.buildAuthorizationUrl(config, {
          redirect_uri: callback, scope: 'openid profile email', state, nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
        });
        res.writeHead(302, { Location: destination.href, 'Set-Cookie': `preview_attempt=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` });
        res.end();
        break;
      }
      case '/callback': {
        const state = req.headers.cookie?.match(/(?:^|; )preview_attempt=([\w-]+)/)?.[1];
        const attempt = attempts.get(state);
        attempts.delete(state);
        if (!attempt || attempt.expires < Date.now()) throw new Error('Sign-in expired');
        const tokens = await oidc.authorizationCodeGrant(config, url, {
          expectedState: state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier,
        });
        const claims = await oidc.fetchUserInfo(config, tokens.access_token, tokens.claims().sub);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(claims, null, 2));
        break;
      }
      default:
        res.writeHead(404).end('Not found');
    }
  } catch {
    res.writeHead(400).end('Sign-in could not finish. Return to http://localhost:3100 and try again.');
  }
}).listen(3100, '127.0.0.1', () => console.log('ReelTone Auth preview at http://localhost:3100'));
