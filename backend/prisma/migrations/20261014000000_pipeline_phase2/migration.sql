ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'site',
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS social_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS score integer,
  ADD COLUMN IF NOT EXISTS score_signals jsonb,
  ADD COLUMN IF NOT EXISTS osm_tags jsonb,
  ADD COLUMN IF NOT EXISTS call_script text,
  ADD COLUMN IF NOT EXISTS audited_at timestamptz,
  ADD COLUMN IF NOT EXISTS screenshot bytea,
  ADD COLUMN IF NOT EXISTS screenshot_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS businesses_track_status_idx ON businesses(track, status);

CREATE TABLE IF NOT EXISTS city_geo_cache (
  id text PRIMARY KEY,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  osm_type text,
  osm_id text,
  display_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS markets (
  code varchar(2) PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  client_value_score integer NOT NULL DEFAULT 50,
  lead_supply_score integer NOT NULL DEFAULT 50,
  email_yield_score integer NOT NULL DEFAULT 50,
  response_score integer NOT NULL DEFAULT 50,
  communication_fit_score integer NOT NULL DEFAULT 50,
  compliance_penalty integer NOT NULL DEFAULT 5,
  gdp_ppp_per_capita double precision,
  gdp_reference_year integer,
  gdp_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT markets_component_scores_check CHECK (
    client_value_score BETWEEN 0 AND 100 AND
    lead_supply_score BETWEEN 0 AND 100 AND
    email_yield_score BETWEEN 0 AND 100 AND
    response_score BETWEEN 0 AND 100 AND
    communication_fit_score BETWEEN 0 AND 100 AND
    compliance_penalty BETWEEN 0 AND 15
  )
);

INSERT INTO markets
  (code, name, enabled, client_value_score, lead_supply_score, email_yield_score, response_score, communication_fit_score, compliance_penalty)
VALUES
  ('US', 'United States', true, 95, 70, 65, 50, 90, 5),
  ('CA', 'Canada', true, 85, 65, 65, 50, 88, 5),
  ('GB', 'United Kingdom', true, 82, 70, 60, 50, 90, 12),
  ('AU', 'Australia', true, 88, 60, 60, 50, 86, 5),
  ('AE', 'United Arab Emirates', true, 90, 45, 55, 50, 72, 5),
  ('SG', 'Singapore', true, 92, 45, 55, 50, 88, 5),
  ('DE', 'Germany', false, 85, 65, 45, 50, 45, 12),
  ('NL', 'Netherlands', false, 82, 55, 50, 50, 60, 12),
  ('IE', 'Ireland', false, 78, 45, 55, 50, 88, 12),
  ('NZ', 'New Zealand', false, 76, 40, 55, 50, 85, 5)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE city_geo_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
