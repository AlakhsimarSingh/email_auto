ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS google_sub text UNIQUE,
  ADD COLUMN IF NOT EXISTS added_by text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_single_owner_idx ON admin_users ((role)) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS auth_otps (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  code_hmac text NOT NULL,
  request_ip_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_otps_email_created_at_idx ON auth_otps(email, created_at);
CREATE INDEX IF NOT EXISTS auth_otps_request_ip_hash_created_at_idx ON auth_otps(request_ip_hash, created_at);

CREATE TABLE IF NOT EXISTS auth_otp_requests (
  id uuid PRIMARY KEY,
  email_hash text NOT NULL,
  request_ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_otp_requests_email_hash_created_at_idx ON auth_otp_requests(email_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_otp_requests_request_ip_hash_created_at_idx ON auth_otp_requests(request_ip_hash, created_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  step_up_until timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_admin_id_revoked_at_idx ON auth_sessions(admin_id, revoked_at);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id text PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL,
  backed_up boolean NOT NULL DEFAULT false,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS passkey_credentials_admin_id_idx ON passkey_credentials(admin_id);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL UNIQUE,
  purpose text NOT NULL,
  admin_id integer REFERENCES admin_users(id) ON DELETE CASCADE,
  session_id uuid,
  request_ip_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passkey_challenges_expires_at_idx ON passkey_challenges(expires_at);
CREATE INDEX IF NOT EXISTS passkey_challenges_request_ip_hash_created_at_idx ON passkey_challenges(request_ip_hash, created_at);

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  admin_id integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gmail_oauth_states_expires_at_idx ON gmail_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS integration_secrets (
  id text PRIMARY KEY,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  actor_email text NOT NULL,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);

CREATE OR REPLACE FUNCTION protect_owner_admin() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.role = 'owner' THEN
    RAISE EXCEPTION 'The owner account cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'owner'
     AND (NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role) THEN
    RAISE EXCEPTION 'The owner account cannot be renamed or demoted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND OLD.role IS DISTINCT FROM 'owner'
     AND EXISTS (SELECT 1 FROM admin_users WHERE role = 'owner') THEN
    RAISE EXCEPTION 'Only one owner account is allowed';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.role = 'owner'
     AND EXISTS (SELECT 1 FROM admin_users WHERE role = 'owner') THEN
    RAISE EXCEPTION 'Only one owner account is allowed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_owner_admin_trigger ON admin_users;
CREATE TRIGGER protect_owner_admin_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION protect_owner_admin();

ALTER TABLE auth_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_otp_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkey_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkey_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
