CREATE TABLE IF NOT EXISTS deals (
  id serial PRIMARY KEY,
  business_id integer NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'replied',
  value_cents integer NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deals_stage_check CHECK (stage IN ('replied', 'conversation', 'call', 'proposal', 'won', 'lost')),
  CONSTRAINT deals_value_check CHECK (value_cents >= 0)
);
CREATE INDEX IF NOT EXISTS deals_stage_updated_idx ON deals(stage, updated_at);
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
