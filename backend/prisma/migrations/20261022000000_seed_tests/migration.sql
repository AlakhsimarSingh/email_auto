CREATE TABLE "seed_test_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" INTEGER NOT NULL,
    "email_hash" TEXT NOT NULL,
    "mailbox_provider" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "tested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seed_test_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seed_test_records_admin_id_tested_at_idx" ON "seed_test_records"("admin_id", "tested_at");
CREATE INDEX "seed_test_records_tested_at_idx" ON "seed_test_records"("tested_at");
ALTER TABLE "seed_test_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seed_test_records"
ADD CONSTRAINT "seed_test_records_admin_id_fkey"
FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
