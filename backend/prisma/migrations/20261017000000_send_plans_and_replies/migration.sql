ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS gmail_thread_id text,
  ADD COLUMN IF NOT EXISTS rfc_message_id text,
  ADD COLUMN IF NOT EXISTS sequence_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_due_at timestamptz;

CREATE TABLE IF NOT EXISTS send_plans (
  id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'draft',
  announced_at timestamptz,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  vetoed_at timestamptz,
  frozen_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_plans_state_check CHECK (state IN ('draft', 'announced', 'frozen', 'vetoed', 'completed')),
  CONSTRAINT send_plans_window_check CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS send_plans_state_window_idx ON send_plans(state, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS send_plan_items (
  id serial PRIMARY KEY,
  send_plan_id uuid NOT NULL REFERENCES send_plans(id) ON DELETE CASCADE,
  email_id integer NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(send_plan_id, email_id)
);
CREATE INDEX IF NOT EXISTS send_plan_items_plan_idx ON send_plan_items(send_plan_id);

CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id integer PRIMARY KEY,
  history_id text,
  last_polled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gmail_sync_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS reply_records (
  id serial PRIMARY KEY,
  gmail_message_id text NOT NULL UNIQUE,
  thread_id text NOT NULL,
  email_id integer REFERENCES emails(id) ON DELETE SET NULL,
  classification text NOT NULL,
  snippet text,
  received_at timestamptz NOT NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_records_classification_check CHECK (
    classification IN ('human', 'unsubscribe', 'complaint', 'bounce', 'auto_reply')
  )
);
CREATE INDEX IF NOT EXISTS reply_records_classification_handled_received_idx
  ON reply_records(classification, handled_at, received_at);
CREATE INDEX IF NOT EXISTS reply_records_email_idx ON reply_records(email_id);

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unsubscribe_tokens_email_idx ON unsubscribe_tokens(email);

ALTER TABLE send_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
