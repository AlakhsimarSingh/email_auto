ALTER TABLE "push_devices"
ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "quiet_start" TEXT,
ADD COLUMN "quiet_end" TEXT,
ADD COLUMN "notify_replies" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_plans" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_digest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "digest_frequency" TEXT NOT NULL DEFAULT 'daily';

CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "target_hash" TEXT NOT NULL,
    "target_ciphertext" BYTEA NOT NULL,
    "target_iv" BYTEA NOT NULL,
    "target_auth_tag" BYTEA NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "quiet_start" TEXT,
    "quiet_end" TEXT,
    "notify_replies" BOOLEAN NOT NULL DEFAULT true,
    "notify_plans" BOOLEAN NOT NULL DEFAULT true,
    "notify_digest" BOOLEAN NOT NULL DEFAULT true,
    "digest_frequency" TEXT NOT NULL DEFAULT 'daily',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_channels_admin_id_type_target_hash_key"
ON "notification_channels"("admin_id", "type", "target_hash");
CREATE INDEX "notification_channels_admin_id_enabled_idx"
ON "notification_channels"("admin_id", "enabled");
ALTER TABLE "notification_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_channels"
ADD CONSTRAINT "notification_channels_admin_id_fkey"
FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_link_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_link_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_link_tokens_token_hash_key" ON "notification_link_tokens"("token_hash");
CREATE INDEX "notification_link_tokens_expires_at_idx" ON "notification_link_tokens"("expires_at");
ALTER TABLE "notification_link_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_link_tokens"
ADD CONSTRAINT "notification_link_tokens_admin_id_fkey"
FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workspace_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_key" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "escalated_at" TIMESTAMPTZ(6),
    CONSTRAINT "workspace_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_notifications_event_key_key" ON "workspace_notifications"("event_key");
CREATE INDEX "workspace_notifications_priority_acknowledged_at_created_at_idx"
ON "workspace_notifications"("priority", "acknowledged_at", "created_at");
ALTER TABLE "workspace_notifications" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" TEXT NOT NULL,
    "notification_id" UUID NOT NULL,
    "device_id" UUID,
    "channel_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "external_message_id" TEXT,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_deliveries_idempotency_key_key" ON "notification_deliveries"("idempotency_key");
CREATE INDEX "notification_deliveries_notification_id_status_idx" ON "notification_deliveries"("notification_id", "status");
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_deliveries"
ADD CONSTRAINT "notification_deliveries_notification_id_fkey"
FOREIGN KEY ("notification_id") REFERENCES "workspace_notifications"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries"
ADD CONSTRAINT "notification_deliveries_device_id_fkey"
FOREIGN KEY ("device_id") REFERENCES "push_devices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries"
ADD CONSTRAINT "notification_deliveries_channel_id_fkey"
FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
