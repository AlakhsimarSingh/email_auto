-- Phase 7: learning agent (arms, memory, feedback, proposals, models, edit diffs, reset snapshots).
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "learned_at" TIMESTAMPTZ(6);
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "learn_outcome" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "selection_info" JSONB;

CREATE TABLE "agent_memory" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMPTZ(6),
    "last_reinforced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_arms" (
    "id" SERIAL NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "successes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failures" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "n" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_arms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_feedback" (
    "id" SERIAL NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "note" TEXT,
    "effect" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_proposals" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "patch" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" TEXT,

    CONSTRAINT "agent_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_models" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "trained_on" INTEGER NOT NULL,
    "metrics" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_models_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "draft_edits" (
    "id" SERIAL NOT NULL,
    "email_id" INTEGER NOT NULL,
    "diff" JSONB NOT NULL,
    "edit_distance" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_edits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reset_snapshots" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reset',
    "payload" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restore_until" TIMESTAMPTZ(6) NOT NULL,
    "restored_at" TIMESTAMPTZ(6),

    CONSTRAINT "reset_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_memory_active_kind_idx" ON "agent_memory"("active", "kind");
CREATE UNIQUE INDEX "agent_arms_dimension_key_key" ON "agent_arms"("dimension", "key");
CREATE INDEX "agent_feedback_created_at_idx" ON "agent_feedback"("created_at");
CREATE INDEX "agent_feedback_target_type_target_id_idx" ON "agent_feedback"("target_type", "target_id");
CREATE INDEX "agent_proposals_status_created_at_idx" ON "agent_proposals"("status", "created_at");
CREATE INDEX "agent_proposals_dedupe_key_idx" ON "agent_proposals"("dedupe_key");
CREATE UNIQUE INDEX "agent_models_kind_version_key" ON "agent_models"("kind", "version");
CREATE UNIQUE INDEX "draft_edits_email_id_key" ON "draft_edits"("email_id");
CREATE INDEX "draft_edits_created_at_idx" ON "draft_edits"("created_at");
CREATE INDEX "reset_snapshots_restore_until_idx" ON "reset_snapshots"("restore_until");

ALTER TABLE "agent_memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_arms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_models" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "draft_edits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reset_snapshots" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "draft_edits" ADD CONSTRAINT "draft_edits_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
