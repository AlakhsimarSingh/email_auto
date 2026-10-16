-- Campaign rotation: OpenStreetMap discovery searches the least recently searched campaign first.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "last_searched_at" TIMESTAMPTZ(6);
