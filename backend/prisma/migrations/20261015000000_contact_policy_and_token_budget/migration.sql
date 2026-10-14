CREATE TABLE IF NOT EXISTS contact_ledger (
  email text PRIMARY KEY,
  domain text NOT NULL,
  business_id integer REFERENCES businesses(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'eligible',
  first_contact_at timestamptz,
  last_contact_at timestamptz,
  eligible_after timestamptz,
  contact_count integer NOT NULL DEFAULT 0,
  block_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_ledger_domain_status_idx
  ON contact_ledger(domain, status);
CREATE INDEX IF NOT EXISTS contact_ledger_eligible_after_idx
  ON contact_ledger(eligible_after);

CREATE TABLE IF NOT EXISTS domain_locks (
  domain text PRIMARY KEY,
  business_id integer REFERENCES businesses(id) ON DELETE SET NULL,
  last_sent_at timestamptz NOT NULL,
  locked_until timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS domain_locks_locked_until_idx
  ON domain_locks(locked_until);

CREATE TABLE IF NOT EXISTS daily_token_usage (
  day date PRIMARY KEY,
  total_tokens integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
