# ReelTone Server

The NestJS service hosts ReelTone Auth, the streaming metadata API, and the Reviews API. All API routes run in the same Node.js process.

| Feature | Entry point |
| --- | --- |
| Auth and OpenID Connect | `/.well-known/openid-configuration`, with the existing issuer and auth URLs |
| Reviews | `/reviews` for the Reviews API |
| Streaming | `GET /api/stream/videos` and `GET /api/stream/videos/:id` |
| Readiness | `/readyz` for Auth and `/reviews/readyz` for Reviews |

The video API reads `streaming/mock_data.csv` and serves the supplied metadata and DASH manifest URLs. Restart the backend after updating the export. dash.js continues to fetch media directly from its CDN.

Auth is in `src/auth/`, Reviews is in `src/reviews/`, and the streaming API is in `src/streaming.ts`.

## Run locally

The [workspace Compose stack](../reeltone-util/README.md#local-development) builds the backend, provisions both PostgreSQL databases, and starts the Reviews and Stream frontends. For a new checkout, create `.env` from `.env.example`, configure the auth keys with `npm run keys:generate`, and create `reviews/.env` from its example. Keep existing local keys and client credentials when switching to this checkout.

To run the backend on the host, use Node.js 24 and an initialized database stack:

```sh
npm ci
npm run dev
```

Auth reads the root `.env`. Reviews reads `reviews/.env`, and container deployments can supply its database settings as `REVIEWS_PGHOST`, `REVIEWS_PGPORT`, `REVIEWS_PGDATABASE`, `REVIEWS_PGUSER` and `REVIEWS_PGPASSWORD`. After `npm run build`, apply migrations with `npm run migration:deploy` for Auth and `npm run migration:reviews` for Reviews using their respective database credentials. Use `REVIEWS_ENABLED=0` for an auth-only development session.

Set `SMTP_USER` and `SMTP_PASS` to your SMTP2GO SMTP credentials. Auth uses `mail.smtp2go.com:587` with STARTTLS and sends sign-up codes and password reset links from `MAIL_FROM`. Use a sender or domain verified in SMTP2GO. For local testing with codes printed in the Auth terminal, set `MAIL_TRANSPORT=console`. [SMTP2GO SMTP relay settings](https://developers.smtp2go.com/docs/smtp-relay)

In a second terminal, run `npm run preview` and open [localhost:3100](http://localhost:3100). This is a local OIDC test client. The profile page is at [localhost:3000/account](http://localhost:3000/account) after sign-in. It accepts an HTTPS profile picture URL.

## OAuth providers

Use `http://localhost:3000` as the local homepage URL and `https://auth.reeltone.site` as the production homepage URL. Register the exact callback below for each upstream provider. Use separate upstream app credentials for local and production environments.

| Provider | Local callback | Production callback |
| --- | --- | --- |
| Google | `http://localhost:3000/social/google/callback` | `https://auth.reeltone.site/social/google/callback` |
| GitHub | `http://localhost:3000/social/github/callback` | `https://auth.reeltone.site/social/github/callback` |

1. In Google Auth Platform, configure Branding and Audience, then create a **Web application** client under **Clients**. Add the local URL in the table to **Authorized redirect URIs**. If required by the Audience settings, add your Google account as a test user. [Google OAuth client setup](https://developers.google.com/workspace/guides/create-credentials)
2. In GitHub, open **Settings → Developer settings → OAuth Apps** and register an OAuth app. Use `http://localhost:3000` as the homepage and the local GitHub callback in the table. Generate a client secret on the app’s settings page. [GitHub OAuth app setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the local `.env`. Restart Auth and open the preview. The sign-in page displays each provider whose credentials are configured.

On first social sign-in, the user chooses their ReelTone username and verifies their contact email. An existing verified ReelTone email requires the original sign-in method.

Auth uses the provider's OAuth `state` to find the original OIDC request and return to its registered app callback. A provider callback with no state returns to the Auth homepage. The homepage lists the apps in `OIDC_CLIENTS`. Use `client_name` and `client_uri` to set each app's display name and homepage. If they are omitted, Auth uses the client ID and the first registered redirect's origin.

## Deploy

Build the server image from this repository and configure the [production Compose stack](../reeltone-util/README.md#production). Provide `AUTH_SECRET`, `AUTH_JWKS` (private JSON key set), `MAIL_FROM`, and `OIDC_CLIENTS` through the production runtime environment. Configure mail with `SMTP_URL` or with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`. A nonempty `SMTP_URL` takes precedence. Keep the signing keys and cookie secret stable across container replacements. Use a distinct client secret for each production application.

Register exact production callback URLs in `OIDC_CLIENTS`. Production clients use `client_secret_basic`, and all clients use authorization code flow with S256 PKCE. Applications discover Auth from `https://auth.reeltone.site/.well-known/openid-configuration` and enforce their own permissions. A password reset revokes the affected Auth sessions and tokens. Downstream applications own revocation of their own session cookies.
