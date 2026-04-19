-- Admin audit log for operator-initiated mutations (BullMQ retry/remove,
-- future destructive admin actions). Keeps a compact forensic trail
-- separate from application logs so a log-rotation policy doesn't erase
-- the evidence.

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "resource" text NOT NULL,
  "result" text NOT NULL,
  "details" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "admin_audit_log_created_at_idx"
  ON "admin_audit_log" ("created_at" DESC);
