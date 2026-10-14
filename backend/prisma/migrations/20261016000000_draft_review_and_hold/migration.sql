ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS orig_subject text,
  ADD COLUMN IF NOT EXISTS manual_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_angle text,
  ADD COLUMN IF NOT EXISTS hold_until timestamptz,
  ADD COLUMN IF NOT EXISTS portfolio_project text,
  ADD COLUMN IF NOT EXISTS draft_confidence double precision;
