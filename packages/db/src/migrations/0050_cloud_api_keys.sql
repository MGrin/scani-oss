-- Cloud API key management for the data-provider service.
--
-- Tier 1 (OSS) keeps using the single DATA_PROVIDER_API_KEY env var — these
-- tables sit unused. Tier 2/3 (managed) swaps the env-based bearer check for
-- a DB lookup against `cloud_api_keys`, keyed by SHA-256 of the presented
-- token. Ownership is tracked via `cloud_users` (the Better-Auth users
-- table for cloud.scani.xyz, separate from backend's users table).
--
-- The matching drizzle schema lives in `apps/data-provider/src/db/schema.ts`.

CREATE TABLE "cloud_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "name" text,
  "image" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cloud_users_email_unique" UNIQUE("email")
);

-- Better-Auth's accounts/sessions/verification tables are served from the
-- same DB as the cloud_users above; prefixed with `cloud_` to live alongside
-- the backend auth tables without collision.
CREATE TABLE "cloud_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "cloud_users"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "cloud_sessions_user_id_idx" ON "cloud_sessions" ("user_id");
CREATE INDEX "cloud_sessions_token_idx" ON "cloud_sessions" ("token");

CREATE TABLE "cloud_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "cloud_users"("id") ON DELETE CASCADE,
  "provider_id" text NOT NULL,
  "account_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "cloud_accounts_user_id_idx" ON "cloud_accounts" ("user_id");

CREATE TABLE "cloud_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "cloud_verifications_identifier_idx" ON "cloud_verifications" ("identifier");

-- cloud_api_keys: the Tier 2/3 bearer-token registry.
--
-- `hashed_key` is SHA-256(raw_token). The raw token is shown to the user
-- exactly once at creation time and never persisted. `key_prefix` is the
-- first 8 chars of the raw token (sk_live_xyz) so we can show a
-- non-sensitive preview in listings.
--
-- `quota_monthly_requests` = null means unlimited; otherwise a future
-- quota check can use `cloud_usage_events` (subject=<owner user id>).
CREATE TABLE "cloud_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "cloud_users"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "key_prefix" text NOT NULL,
  "hashed_key" text NOT NULL,
  "tier" text NOT NULL DEFAULT 'free',
  "billing_status" text NOT NULL DEFAULT 'active',
  "quota_monthly_requests" integer,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cloud_api_keys_hashed_key_unique" UNIQUE("hashed_key"),
  CONSTRAINT "cloud_api_keys_tier_check" CHECK ("tier" IN ('free', 'starter', 'pro', 'enterprise', 'internal')),
  CONSTRAINT "cloud_api_keys_billing_status_check" CHECK ("billing_status" IN ('active', 'past_due', 'suspended', 'cancelled'))
);

CREATE INDEX "cloud_api_keys_owner_user_id_idx" ON "cloud_api_keys" ("owner_user_id");
CREATE INDEX "cloud_api_keys_tenant_id_idx" ON "cloud_api_keys" ("tenant_id");
CREATE INDEX "cloud_api_keys_hashed_key_idx" ON "cloud_api_keys" ("hashed_key") WHERE "revoked_at" IS NULL;
