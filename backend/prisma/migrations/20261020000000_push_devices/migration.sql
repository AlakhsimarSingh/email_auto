CREATE TABLE "push_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" INTEGER NOT NULL,
    "session_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_test_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_devices_endpoint_key" ON "push_devices"("endpoint");
CREATE INDEX "push_devices_admin_id_enabled_idx" ON "push_devices"("admin_id", "enabled");
CREATE INDEX "push_devices_session_id_idx" ON "push_devices"("session_id");

ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "push_devices"
ADD CONSTRAINT "push_devices_admin_id_fkey"
FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_devices"
ADD CONSTRAINT "push_devices_session_id_fkey"
FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
