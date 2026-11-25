CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,30}$'),
    first_name text,
    last_name text,
    profile_picture_url text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_username_unique ON accounts (lower(username));

CREATE TABLE account_emails (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    email text NOT NULL,
    normalized_email text NOT NULL,
    verified_at timestamptz,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_emails_verified_unique ON account_emails (normalized_email) WHERE verified_at IS NOT NULL;
CREATE UNIQUE INDEX account_emails_primary_unique ON account_emails (account_id) WHERE is_primary;

CREATE TABLE password_credentials (
    account_id uuid PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    password_hash text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('google', 'github')),
    provider_user_id text NOT NULL,
    provider_username text,
    provider_display_name text,
    provider_first_name text,
    provider_last_name text,
    provider_email text,
    provider_email_verified boolean NOT NULL DEFAULT false,
    provider_picture_url text,
    linked_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);

CREATE TABLE email_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_email_id uuid REFERENCES account_emails ON DELETE CASCADE,
    email text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
    interaction_id text,
    secret_digest bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_challenges_expiry ON email_challenges (expires_at);

CREATE TABLE oauth_login_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('google', 'github')),
    interaction_id text NOT NULL,
    state_digest bytea NOT NULL UNIQUE,
    pkce_verifier text NOT NULL,
    nonce text,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    identity jsonb
);
CREATE INDEX oauth_login_attempts_expiry ON oauth_login_attempts (expires_at);

CREATE TABLE oidc_artifacts (
    model text NOT NULL,
    id text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    grant_id text,
    interaction_uid text,
    user_code text,
    PRIMARY KEY (model, id)
);
CREATE INDEX oidc_artifacts_expiry ON oidc_artifacts (expires_at);
CREATE INDEX oidc_artifacts_grant ON oidc_artifacts (grant_id);
CREATE INDEX oidc_artifacts_uid ON oidc_artifacts (model, interaction_uid);
CREATE INDEX oidc_artifacts_user_code ON oidc_artifacts (model, user_code);
CREATE INDEX oidc_artifacts_account ON oidc_artifacts ((payload->>'accountId'));

CREATE TABLE auth_rate_limits (
    key bytea PRIMARY KEY,
    hits integer NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits (expires_at);
