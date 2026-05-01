CREATE TYPE "public"."credentials_import_status" AS ENUM('pending_enqueue', 'enqueued', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_job_state" AS ENUM('queued', 'active', 'progress', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "account_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_user_id_institution_id_name_unique" UNIQUE("user_id","institution_id","name")
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"result" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"hashed_key" text NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"billing_status" text DEFAULT 'active' NOT NULL,
	"quota_monthly_requests" integer,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_api_keys_hashed_key_unique" UNIQUE("hashed_key")
);
--> statement-breakpoint
CREATE TABLE "cloud_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "cloud_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"api_key_id" text,
	"tenant_id" text,
	"request_id" text,
	"route" text NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"bytes_in" integer,
	"bytes_out" integer,
	"upstream_cost_usd" real,
	"error_code" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "cloud_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_account_id_group_id_unique" UNIQUE("account_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"display_order" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "holding_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_groups_holding_id_group_id_unique" UNIQUE("holding_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "holding_apy_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"annual_rate_pct" text NOT NULL,
	"payout_frequency" text NOT NULL,
	"payout_day_of_week" real,
	"payout_day_of_month" real,
	"payout_month" real,
	"last_payout_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_apy_configs_holding_id_unique" UNIQUE("holding_id")
);
--> statement-breakpoint
CREATE TABLE "holding_balance_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"holding_id" uuid NOT NULL,
	"balance" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_obs_dedup" UNIQUE("holding_id","observed_at","source")
);
--> statement-breakpoint
CREATE TABLE "holding_coverage" (
	"holding_id" uuid PRIMARY KEY NOT NULL,
	"first_tx_at" timestamp with time zone,
	"last_tx_at" timestamp with time zone,
	"first_observation_at" timestamp with time zone,
	"last_observation_at" timestamp with time zone,
	"tx_sources" text[] DEFAULT '{}' NOT NULL,
	"has_complete_tx_history" boolean DEFAULT false NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"opening_balance_quantity" text,
	"reconciliation_notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holding_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"holding_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" text NOT NULL,
	"price_native" text,
	"price_native_token_id" uuid,
	"counter_token_id" uuid,
	"counter_quantity" text,
	"counter_price_native" text,
	"counter_price_native_token_id" uuid,
	"fee_quantity" text,
	"fee_token_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"external_id" text NOT NULL,
	"swap_group_id" uuid,
	"transfer_group_id" uuid,
	"source" text NOT NULL,
	"source_metadata" jsonb DEFAULT '{}' NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_tx_dedup" UNIQUE("holding_id","source","external_id")
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"balance" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_blockchain_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"chain_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_blockchain_mappings_institution_id_unique" UNIQUE("institution_id")
);
--> statement-breakpoint
CREATE TABLE "institution_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"description" text,
	"website" text,
	"logo_url" text,
	"has_integration" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_website_unique" UNIQUE("website")
);
--> statement-breakpoint
CREATE TABLE "portfolio_value_daily" (
	"user_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"base_currency_id" uuid NOT NULL,
	"total_value" text NOT NULL,
	"coverage_quality" text NOT NULL,
	"holdings_with_known_value" integer NOT NULL,
	"holdings_total" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_value_daily_user_id_snapshot_date_base_currency_id_pk" PRIMARY KEY("user_id","snapshot_date","base_currency_id")
);
--> statement-breakpoint
CREATE TABLE "token_price_edit_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"base_token_id" uuid NOT NULL,
	"previous_price" text,
	"new_price" text NOT NULL,
	"edited_by_user_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"base_token_id" uuid NOT NULL,
	"price" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"source" text,
	"granularity" text DEFAULT 'intraday' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_prices_token_base_ts_gran_unique" UNIQUE("token_id","base_token_id","timestamp","granularity")
);
--> statement-breakpoint
CREATE TABLE "token_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"decimals" real DEFAULT 2 NOT NULL,
	"market_segment" text,
	"icon_url" text,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_scam_probability" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_pool_borrow_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"borrowed_from_user_id" uuid,
	"borrowed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_pool_state" (
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"last_borrowed_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"quarantined_until" timestamp with time zone,
	"total_borrows_count" integer DEFAULT 0 NOT NULL,
	"total_failures_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credential_pool_state_user_id_institution_id_pk" PRIMARY KEY("user_id","institution_id")
);
--> statement-breakpoint
CREATE TABLE "user_integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"encrypted_credentials" jsonb NOT NULL,
	"credentials_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"import_status" "credentials_import_status" DEFAULT 'enqueued' NOT NULL,
	"import_job_id" text,
	"import_enqueued_at" timestamp with time zone,
	"import_last_error" text,
	"import_retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_integration_credentials_user_id_institution_id_unique" UNIQUE("user_id","institution_id")
);
--> statement-breakpoint
CREATE TABLE "user_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_name" text NOT NULL,
	"state" "user_job_state" DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts_made" integer DEFAULT 0 NOT NULL,
	"attempts_allowed" integer DEFAULT 1 NOT NULL,
	"payload_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_taken_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"institution_ids" jsonb DEFAULT '[]' NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_wallets_user_id_wallet_address_unique" UNIQUE("user_id","wallet_address")
);
--> statement-breakpoint
CREATE TABLE "user_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"avatar" text,
	"image" text,
	"base_currency_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vault_id" uuid NOT NULL,
	"holding_id" uuid NOT NULL,
	"percentage" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_holdings_vault_id_holding_id_unique" UNIQUE("vault_id","holding_id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_amount" text NOT NULL,
	"currency_id" uuid NOT NULL,
	"current_amount" text DEFAULT '0' NOT NULL,
	"color" text NOT NULL,
	"icon_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_type_id_account_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."account_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_user_id_cloud_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."cloud_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_api_keys" ADD CONSTRAINT "cloud_api_keys_owner_user_id_cloud_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."cloud_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sessions" ADD CONSTRAINT "cloud_sessions_user_id_cloud_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."cloud_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_apy_configs" ADD CONSTRAINT "holding_apy_configs_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_balance_observations" ADD CONSTRAINT "holding_balance_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_balance_observations" ADD CONSTRAINT "holding_balance_observations_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_coverage" ADD CONSTRAINT "holding_coverage_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_price_native_token_id_tokens_id_fk" FOREIGN KEY ("price_native_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_counter_token_id_tokens_id_fk" FOREIGN KEY ("counter_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_counter_price_native_token_id_tokens_id_fk" FOREIGN KEY ("counter_price_native_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_transactions" ADD CONSTRAINT "holding_transactions_fee_token_id_tokens_id_fk" FOREIGN KEY ("fee_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_blockchain_mappings" ADD CONSTRAINT "institution_blockchain_mappings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_type_id_institution_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."institution_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_value_daily" ADD CONSTRAINT "portfolio_value_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_value_daily" ADD CONSTRAINT "portfolio_value_daily_base_currency_id_tokens_id_fk" FOREIGN KEY ("base_currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_price_edit_history" ADD CONSTRAINT "token_price_edit_history_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_price_edit_history" ADD CONSTRAINT "token_price_edit_history_base_token_id_tokens_id_fk" FOREIGN KEY ("base_token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_price_edit_history" ADD CONSTRAINT "token_price_edit_history_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_prices" ADD CONSTRAINT "token_prices_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_prices" ADD CONSTRAINT "token_prices_base_token_id_tokens_id_fk" FOREIGN KEY ("base_token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_type_id_token_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."token_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool_borrow_log" ADD CONSTRAINT "credential_pool_borrow_log_borrowed_from_user_id_users_id_fk" FOREIGN KEY ("borrowed_from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool_state" ADD CONSTRAINT "credential_pool_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool_state" ADD CONSTRAINT "credential_pool_state_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_jobs" ADD CONSTRAINT "user_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_base_currency_id_tokens_id_fk" FOREIGN KEY ("base_currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_holdings" ADD CONSTRAINT "vault_holdings_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_holdings" ADD CONSTRAINT "vault_holdings_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_currency_id_tokens_id_fk" FOREIGN KEY ("currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_institution_id" ON "accounts" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_user_institution" ON "accounts" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cloud_accounts_user_id_idx" ON "cloud_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cloud_api_keys_owner_user_id_idx" ON "cloud_api_keys" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "cloud_api_keys_tenant_id_idx" ON "cloud_api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cloud_sessions_user_id_idx" ON "cloud_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cloud_sessions_token_idx" ON "cloud_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "cloud_usage_events_subject_occurred_at_idx" ON "cloud_usage_events" USING btree ("subject","occurred_at");--> statement-breakpoint
CREATE INDEX "cloud_verifications_identifier_idx" ON "cloud_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_account_groups_account_id" ON "account_groups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_groups_group_id" ON "account_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_groups_user_id" ON "groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_groups_display_order" ON "groups" USING btree ("user_id","display_order");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_holding_id" ON "holding_groups" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_group_id" ON "holding_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_holding_apy_configs_holding_id" ON "holding_apy_configs" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_holding_apy_configs_active" ON "holding_apy_configs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_holding_obs_holding_observed" ON "holding_balance_observations" USING btree ("holding_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_obs_user_observed" ON "holding_balance_observations" USING btree ("user_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_tx_user_occurred" ON "holding_transactions" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_tx_holding_occurred" ON "holding_transactions" USING btree ("holding_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_tx_transfer_group" ON "holding_transactions" USING btree ("transfer_group_id");--> statement-breakpoint
CREATE INDEX "idx_holding_tx_swap_group" ON "holding_transactions" USING btree ("swap_group_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_id" ON "holdings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_account_id" ON "holdings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_token_id" ON "holdings" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_account_token" ON "holdings" USING btree ("user_id","account_id","token_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_token" ON "holdings" USING btree ("user_id","token_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_is_hidden" ON "holdings" USING btree ("is_hidden");--> statement-breakpoint
CREATE INDEX "idx_holdings_is_active" ON "holdings" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_holdings_account_token_external" ON "holdings" USING btree ("account_id","token_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_institution_blockchain_mappings_institution_id" ON "institution_blockchain_mappings" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_institution_blockchain_mappings_chain_id" ON "institution_blockchain_mappings" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "idx_institutions_name" ON "institutions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_portfolio_value_daily_user_date" ON "portfolio_value_daily" USING btree ("user_id","snapshot_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_price_edit_history_token_created" ON "token_price_edit_history" USING btree ("token_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_price_edit_history_user_created" ON "token_price_edit_history" USING btree ("edited_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_prices_lookup" ON "token_prices" USING btree ("token_id","base_token_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_prices_timestamp" ON "token_prices" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_prices_granularity_lookup" ON "token_prices" USING btree ("token_id","base_token_id","granularity","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_tokens_symbol" ON "tokens" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_tokens_type_id" ON "tokens" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "credential_pool_borrow_log_user_idx" ON "credential_pool_borrow_log" USING btree ("borrowed_from_user_id","borrowed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credential_pool_borrow_log_provider_idx" ON "credential_pool_borrow_log" USING btree ("provider_key","borrowed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_id" ON "user_integration_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_institution_id" ON "user_integration_credentials" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_institution" ON "user_integration_credentials" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_jobs_user_created" ON "user_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_jobs_user_state_created" ON "user_jobs" USING btree ("user_id","state","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_user_id" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_wallet_address" ON "user_wallets" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_vault_holdings_vault_id" ON "vault_holdings" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "idx_vault_holdings_holding_id" ON "vault_holdings" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_vaults_user_id" ON "vaults" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_vaults_user_active" ON "vaults" USING btree ("user_id","is_active");--> statement-breakpoint

-- =========================================================================
-- CHECK constraints (raw-SQL-only — Drizzle schema has no `check()` helper
-- in use here). Domain-invariant guards so a rogue psql session can't
-- corrupt the data the application layer already validates.
-- =========================================================================

ALTER TABLE "holdings"
  ADD CONSTRAINT "holdings_balance_nonneg_chk"
  CHECK ((balance)::numeric >= 0);--> statement-breakpoint

ALTER TABLE "vault_holdings"
  ADD CONSTRAINT "vault_holdings_percentage_range_chk"
  CHECK (percentage > 0 AND percentage <= 100);--> statement-breakpoint

ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_decimals_nonneg_chk"
  CHECK (decimals >= 0);--> statement-breakpoint

ALTER TABLE "holding_apy_configs"
  ADD CONSTRAINT "holding_apy_configs_rate_nonneg_chk"
  CHECK ((annual_rate_pct)::numeric >= 0);--> statement-breakpoint

ALTER TABLE "cloud_api_keys"
  ADD CONSTRAINT "cloud_api_keys_tier_check"
  CHECK ("tier" IN ('free', 'starter', 'pro', 'enterprise', 'internal'));--> statement-breakpoint

ALTER TABLE "cloud_api_keys"
  ADD CONSTRAINT "cloud_api_keys_billing_status_check"
  CHECK ("billing_status" IN ('active', 'past_due', 'suspended', 'cancelled'));--> statement-breakpoint

-- Partial index on cloud_api_keys.hashed_key — fast lookup of active
-- (non-revoked) keys at auth time. Drizzle schema has no partial-index
-- helper in use, so it lives here.
CREATE INDEX "cloud_api_keys_hashed_key_idx"
  ON "cloud_api_keys" ("hashed_key")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

-- =========================================================================
-- tokens — 3-tuple uniqueness + EVM contract index. Drizzle's `unique()`
-- can't express COALESCE() so the constraint lives here as a unique
-- INDEX instead. Same constraint name the app references at the
-- ON CONFLICT site in TokenService.
-- =========================================================================
CREATE UNIQUE INDEX "tokens_symbol_type_segment_unique"
  ON "tokens" ("symbol", "type_id", COALESCE("market_segment", ''));--> statement-breakpoint

-- Partial jsonb expression index for EVM contract lookups
-- (providerMetadata.etherscan.{chainId, contractAddress}).
CREATE INDEX "tokens_etherscan_contract_idx"
  ON "tokens" (
    ("provider_metadata"->'etherscan'->>'chainId'),
    ("provider_metadata"->'etherscan'->>'contractAddress')
  )
  WHERE "provider_metadata" ? 'etherscan';--> statement-breakpoint

-- =========================================================================
-- SEED DATA: dynamic enums (token_types, institution_types, account_types)
-- =========================================================================
-- Seed enum-table rows: token_types, institution_types, account_types.
-- These are "dynamic enums" (DB rows, not SQL enums) referenced by the
-- application's domain code; inserts are idempotent via ON CONFLICT.

INSERT INTO token_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('fiat',            'Fiat Currency',                   'Government-issued currencies (USD, EUR, etc.)',                           true, 0, now(), now()),
  ('crypto',          'Cryptocurrency',                  'Digital cryptocurrencies (BTC, ETH, etc.)',                               true, 1, now(), now()),
  ('stock',           'Stock / ETF / Equity / Commodity','Publicly traded stocks and equities, including ETFs, Commodities, etc.', true, 2, now(), now()),
  ('private-company', 'Private Company',                 'Private Company, not having a public price available',                   true, 3, now(), now()),
  ('other',           'Other',                           'Other type of asset',                                                     true, 4, now(), now())
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO institution_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('bank',             'Bank',             'Traditional banks and credit unions',                                                        true, 0, now(), now()),
  ('broker',           'Brokerage',        'Investment brokerages and trading platforms',                                                true, 3, now(), now()),
  ('crypto_wallet',    'Crypto Wallet',    'Cryptocurrency wallets and custodial services',                                              true, 1, now(), now()),
  ('crypto_exchange',  'Crypto Exchange',  'Cryptocurrency exchanges and trading platforms',                                             true, 2, now(), now()),
  ('investment_fund',  'Investment Fund',  'Any type of investement fund you keep your money in',                                        true, 4, now(), now()),
  ('private_equity',   'Private Equity',   'Institution focused on private equity investments. Example: Carta, EquityZen, Ledgy',        true, 6, now(), now()),
  ('real_estate',      'Real Estate',      'Real estate investment and management firms',                                                true, 5, now(), now()),
  ('other',            'Other',            'Other financial institutions',                                                               true, 7, now(), now())
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO account_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('checking',   'Checking Account',    'Everyday spending and transaction accounts', true, 0, now(), now()),
  ('savings',    'Savings Account',     'Interest-bearing savings accounts',          true, 1, now(), now()),
  ('investment', 'Investment Account',  'General investment and brokerage accounts',  true, 2, now(), now()),
  ('crypto',     'Cryptocurrency',      'Cryptocurrency accounts',                    true, 3, now(), now()),
  ('other',      'Other',               'Other account types',                        true, 4, now(), now())
ON CONFLICT (code) DO NOTHING;

-- =========================================================================
-- SEED DATA: fiat tokens
-- =========================================================================
-- Custom SQL migration file, put your code below! --
-- Seed fiat currency tokens
-- This migration inserts all major world fiat currencies into the tokens table

-- First, get the fiat token type ID
DO $$
DECLARE
  fiat_type_id UUID;
BEGIN
  -- Get the fiat token type ID
  SELECT id INTO fiat_type_id FROM token_types WHERE code = 'fiat';

  -- Insert all major world fiat currencies
  INSERT INTO tokens (
    symbol,
    name,
    type_id,
    decimals,
    icon_url,
    provider_metadata,
    is_active,
    created_at,
    updated_at
  )
  VALUES
    -- Major currencies (G7 + China)
    ('USD', 'United States Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('EUR', 'Euro', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('JPY', 'Japanese Yen', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('GBP', 'British Pound Sterling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CAD', 'Canadian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CHF', 'Swiss Franc', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CNY', 'Chinese Yuan', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Other major global currencies
    ('AUD', 'Australian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NZD', 'New Zealand Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HKD', 'Hong Kong Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SGD', 'Singapore Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Asian currencies
    ('INR', 'Indian Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KRW', 'South Korean Won', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('IDR', 'Indonesian Rupiah', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('THB', 'Thai Baht', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MYR', 'Malaysian Ringgit', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PHP', 'Philippine Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('VND', 'Vietnamese Dong', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('TWD', 'New Taiwan Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PKR', 'Pakistani Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BDT', 'Bangladeshi Taka', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LKR', 'Sri Lankan Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Middle Eastern currencies
    ('SAR', 'Saudi Riyal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AED', 'UAE Dirham', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('QAR', 'Qatari Riyal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KWD', 'Kuwaiti Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('BHD', 'Bahraini Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('OMR', 'Omani Rial', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('ILS', 'Israeli New Shekel', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TRY', 'Turkish Lira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('JOD', 'Jordanian Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('LBP', 'Lebanese Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- European currencies (non-Euro)
    ('SEK', 'Swedish Krona', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NOK', 'Norwegian Krone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DKK', 'Danish Krone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PLN', 'Polish Zloty', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CZK', 'Czech Koruna', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HUF', 'Hungarian Forint', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('RON', 'Romanian Leu', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BGN', 'Bulgarian Lev', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HRK', 'Croatian Kuna', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RSD', 'Serbian Dinar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UAH', 'Ukrainian Hryvnia', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RUB', 'Russian Ruble', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ISK', 'Icelandic Krona', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    
    -- Latin American currencies
    ('BRL', 'Brazilian Real', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MXN', 'Mexican Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ARS', 'Argentine Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CLP', 'Chilean Peso', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('COP', 'Colombian Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PEN', 'Peruvian Sol', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UYU', 'Uruguayan Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BOB', 'Bolivian Boliviano', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PYG', 'Paraguayan Guarani', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('VES', 'Venezuelan Bolívar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- African currencies
    ('ZAR', 'South African Rand', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NGN', 'Nigerian Naira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('EGP', 'Egyptian Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KES', 'Kenyan Shilling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GHS', 'Ghanaian Cedi', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TZS', 'Tanzanian Shilling', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('UGX', 'Ugandan Shilling', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('MAD', 'Moroccan Dirham', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TND', 'Tunisian Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('ETB', 'Ethiopian Birr', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('XOF', 'West African CFA Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('XAF', 'Central African CFA Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    
    -- Oceania currencies
    ('FJD', 'Fijian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PGK', 'Papua New Guinean Kina', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Other notable currencies
    ('AFN', 'Afghan Afghani', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AMD', 'Armenian Dram', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AZN', 'Azerbaijani Manat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BYN', 'Belarusian Ruble', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GEL', 'Georgian Lari', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KZT', 'Kazakhstani Tenge', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KGS', 'Kyrgyzstani Som', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MNT', 'Mongolian Tugrik', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UZS', 'Uzbekistani Som', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TMT', 'Turkmenistani Manat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TJS', 'Tajikistani Somoni', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Caribbean and Central American currencies
    ('JMD', 'Jamaican Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TTD', 'Trinidad and Tobago Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BBD', 'Barbadian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BZD', 'Belize Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GTQ', 'Guatemalan Quetzal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HNL', 'Honduran Lempira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NIO', 'Nicaraguan Córdoba', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CRC', 'Costa Rican Colón', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PAB', 'Panamanian Balboa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DOP', 'Dominican Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HTG', 'Haitian Gourde', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CUP', 'Cuban Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Pegged/Special currencies
    ('XCD', 'East Caribbean Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Baltic countries
    ('ALL', 'Albanian Lek', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MKD', 'Macedonian Denar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BAM', 'Bosnia-Herzegovina Convertible Mark', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional Asian currencies
    ('LAK', 'Laotian Kip', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KHR', 'Cambodian Riel', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MMK', 'Myanmar Kyat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BND', 'Brunei Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NPR', 'Nepalese Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BTN', 'Bhutanese Ngultrum', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MVR', 'Maldivian Rufiyaa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional Middle Eastern currencies
    ('IQD', 'Iraqi Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('IRR', 'Iranian Rial', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SYP', 'Syrian Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('YER', 'Yemeni Rial', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional African currencies
    ('BWP', 'Botswana Pula', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MUR', 'Mauritian Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MWK', 'Malawian Kwacha', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MZN', 'Mozambican Metical', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NAD', 'Namibian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ZMW', 'Zambian Kwacha', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ZWL', 'Zimbabwean Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AOA', 'Angolan Kwanza', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DZD', 'Algerian Dinar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LYD', 'Libyan Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('SDG', 'Sudanese Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SOS', 'Somali Shilling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DJF', 'Djiboutian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('ERN', 'Eritrean Nakfa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RWF', 'Rwandan Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('BIF', 'Burundian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('SZL', 'Swazi Lilangeni', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LSL', 'Lesotho Loti', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GMD', 'Gambian Dalasi', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GNF', 'Guinean Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('SLL', 'Sierra Leonean Leone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LRD', 'Liberian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MRU', 'Mauritanian Ouguiya', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SCR', 'Seychellois Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CVE', 'Cape Verdean Escudo', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('STN', 'São Tomé and Príncipe Dobra', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KMF', 'Comorian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('CDF', 'Congolese Franc', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MGA', 'Malagasy Ariary', fiat_type_id, 2, NULL, '{}', true, now(), now())
  ON CONFLICT (symbol, type_id, COALESCE(market_segment, '')) DO NOTHING;

END $$;
-- =========================================================================
-- SEED DATA: institutions (CEX/brokers/banks/etc.)
-- =========================================================================
-- Custom SQL migration file, put your code below! --
-- Seed global financial institutions
-- This migration inserts major banks, brokers, crypto exchanges, wallets, and other financial institutions worldwide

DO $$
DECLARE
  bank_type_id UUID;
  broker_type_id UUID;
  crypto_wallet_type_id UUID;
  crypto_exchange_type_id UUID;
  investment_fund_type_id UUID;
  private_equity_type_id UUID;
  real_estate_type_id UUID;
  other_type_id UUID;
BEGIN
  -- Get institution type IDs
  SELECT id INTO bank_type_id FROM institution_types WHERE code = 'bank';
  SELECT id INTO broker_type_id FROM institution_types WHERE code = 'broker';
  SELECT id INTO crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';
  SELECT id INTO crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';
  SELECT id INTO investment_fund_type_id FROM institution_types WHERE code = 'investment_fund';
  SELECT id INTO private_equity_type_id FROM institution_types WHERE code = 'private_equity';
  SELECT id INTO real_estate_type_id FROM institution_types WHERE code = 'real_estate';
  SELECT id INTO other_type_id FROM institution_types WHERE code = 'other';

  -- Insert institutions
  INSERT INTO institutions (
    name,
    type_id,
    description,
    website,
    logo_url,
    is_active,
    created_at,
    updated_at
  )
  VALUES
    -- ========================================
    -- BANKS - NORTH AMERICA
    -- ========================================
    ('JPMorgan Chase', bank_type_id, 'Largest bank in the United States by assets', 'https://www.jpmorganchase.com', NULL, true, now(), now()),
    ('Bank of America', bank_type_id, 'Major American multinational investment bank and financial services holding company', 'https://www.bankofamerica.com', NULL, true, now(), now()),
    ('Citigroup', bank_type_id, 'Global financial services corporation', 'https://www.citigroup.com', NULL, true, now(), now()),
    ('Wells Fargo', bank_type_id, 'American multinational financial services company', 'https://www.wellsfargo.com', NULL, true, now(), now()),
    ('Goldman Sachs', bank_type_id, 'Leading global investment banking, securities and investment management firm', 'https://www.goldmansachs.com', NULL, true, now(), now()),
    ('Morgan Stanley', bank_type_id, 'American multinational investment bank and financial services company', 'https://www.morganstanley.com', NULL, true, now(), now()),
    ('U.S. Bancorp', bank_type_id, 'American bank holding company based in Minneapolis', 'https://www.usbank.com', NULL, true, now(), now()),
    ('Capital One', bank_type_id, 'American bank holding company specializing in credit cards, auto loans, banking, and savings accounts', 'https://www.capitalone.com', NULL, true, now(), now()),
    ('PNC Financial Services', bank_type_id, 'Major bank in the United States', 'https://www.pnc.com', NULL, true, now(), now()),
    ('Truist Financial', bank_type_id, 'American bank holding company formed by the merger of BB&T and SunTrust', 'https://www.truist.com', NULL, true, now(), now()),
    ('Charles Schwab', bank_type_id, 'American multinational financial services corporation', 'https://www.schwab.com', NULL, true, now(), now()),
    ('BNY Mellon', bank_type_id, 'American investment banking services holding company', 'https://www.bnymellon.com', NULL, true, now(), now()),

    -- BANKS - CANADA
    ('Royal Bank of Canada', bank_type_id, 'Largest bank in Canada by market capitalization', 'https://www.rbc.com', NULL, true, now(), now()),
    ('Toronto-Dominion Bank', bank_type_id, 'Canadian multinational banking and financial services corporation', 'https://www.td.com', NULL, true, now(), now()),
    ('Bank of Nova Scotia', bank_type_id, 'Canadian multinational banking and financial services company', 'https://www.scotiabank.com', NULL, true, now(), now()),
    ('Bank of Montreal', bank_type_id, 'Canadian multinational investment bank and financial services company', 'https://www.bmo.com', NULL, true, now(), now()),
    ('Canadian Imperial Bank of Commerce', bank_type_id, 'Canadian banking and financial services corporation', 'https://www.cibc.com', NULL, true, now(), now()),
    ('National Bank of Canada', bank_type_id, 'Sixth largest commercial bank in Canada', 'https://www.nbc.ca', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - EUROPE
    -- ========================================
    ('HSBC', bank_type_id, 'British multinational universal bank and financial services holding company', 'https://www.hsbc.com', NULL, true, now(), now()),
    ('BNP Paribas', bank_type_id, 'French international banking group', 'https://www.bnpparibas.com', NULL, true, now(), now()),
    ('Crédit Agricole', bank_type_id, 'French network of cooperative and mutual banks', 'https://www.credit-agricole.com', NULL, true, now(), now()),
    ('Banco Santander', bank_type_id, 'Spanish multinational financial services company', 'https://www.santander.com', NULL, true, now(), now()),
    ('Barclays', bank_type_id, 'British multinational universal bank', 'https://www.barclays.com', NULL, true, now(), now()),
    ('Société Générale', bank_type_id, 'French multinational investment bank and financial services company', 'https://www.societegenerale.com', NULL, true, now(), now()),
    ('UBS', bank_type_id, 'Swiss multinational investment bank and financial services company', 'https://www.ubs.com', NULL, true, now(), now()),
    ('Deutsche Bank', bank_type_id, 'German multinational investment bank and financial services company', 'https://www.db.com', NULL, true, now(), now()),
    ('Lloyds Banking Group', bank_type_id, 'British financial institution formed through the acquisition of HBOS', 'https://www.lloydsbankinggroup.com', NULL, true, now(), now()),
    ('ING Group', bank_type_id, 'Dutch multinational banking and financial services corporation', 'https://www.ing.com', NULL, true, now(), now()),
    ('Intesa Sanpaolo', bank_type_id, 'Italian banking group resulting from the merger of Banca Intesa and Sanpaolo IMI', 'https://www.intesasanpaolo.com', NULL, true, now(), now()),
    ('NatWest Group', bank_type_id, 'British banking and insurance holding company', 'https://www.natwestgroup.com', NULL, true, now(), now()),
    ('UniCredit', bank_type_id, 'Italian global banking and financial services company', 'https://www.unicredit.eu', NULL, true, now(), now()),
    ('Standard Chartered', bank_type_id, 'British multinational banking and financial services company', 'https://www.sc.com', NULL, true, now(), now()),
    ('Banco Bilbao Vizcaya Argentaria', bank_type_id, 'Spanish multinational financial services company', 'https://www.bbva.com', NULL, true, now(), now()),
    ('DZ Bank', bank_type_id, 'German central institution for cooperative banks', 'https://www.dzbank.com', NULL, true, now(), now()),
    ('Rabobank', bank_type_id, 'Dutch multinational banking and financial services company', 'https://www.rabobank.com', NULL, true, now(), now()),
    ('CaixaBank', bank_type_id, 'Spanish bank based in Valencia', 'https://www.caixabank.com', NULL, true, now(), now()),
    ('Nordea', bank_type_id, 'Nordic financial services group', 'https://www.nordea.com', NULL, true, now(), now()),
    ('Commerzbank', bank_type_id, 'German global banking and financial services company', 'https://www.commerzbank.com', NULL, true, now(), now()),
    ('Danske Bank', bank_type_id, 'Danish bank operating as a universal bank', 'https://www.danskebank.com', NULL, true, now(), now()),
    ('ABN AMRO', bank_type_id, 'Dutch bank with headquarters in Amsterdam', 'https://www.abnamro.com', NULL, true, now(), now()),
    ('KBC Group', bank_type_id, 'Belgian universal multi-channel bank-insurer', 'https://www.kbc.com', NULL, true, now(), now()),
    ('Erste Group', bank_type_id, 'Austrian banking group headquartered in Vienna', 'https://www.erstegroup.com', NULL, true, now(), now()),
    ('SEB Group', bank_type_id, 'Swedish financial services group for corporate customers, institutions and private individuals', 'https://www.sebgroup.com', NULL, true, now(), now()),
    ('Handelsbanken', bank_type_id, 'Swedish bank providing banking services and financial solutions', 'https://www.handelsbanken.com', NULL, true, now(), now()),
    ('DNB', bank_type_id, 'Norwegian financial services group', 'https://www.dnb.no', NULL, true, now(), now()),
    ('Raiffeisen Bank International', bank_type_id, 'Austrian banking group headquartered in Vienna', 'https://www.rbinternational.com', NULL, true, now(), now()),
    ('Credit Suisse', bank_type_id, 'Swiss investment bank and financial services firm (now part of UBS)', 'https://www.credit-suisse.com', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - ASIA
    -- ========================================
    ('Industrial and Commercial Bank of China', bank_type_id, 'Largest bank in the world by total assets', 'https://www.icbc.com.cn', NULL, true, now(), now()),
    ('China Construction Bank', bank_type_id, 'One of the largest banks in China', 'https://www.ccb.com', NULL, true, now(), now()),
    ('Agricultural Bank of China', bank_type_id, 'One of the Big Four banks in China', 'https://www.abchina.com', NULL, true, now(), now()),
    ('Bank of China', bank_type_id, 'Chinese state-owned commercial bank', 'https://www.boc.cn', NULL, true, now(), now()),
    ('Mitsubishi UFJ Financial Group', bank_type_id, 'Japanese bank holding and financial services company', 'https://www.mufg.jp', NULL, true, now(), now()),
    ('SMBC Group', bank_type_id, 'Japanese financial services company', 'https://www.smbc.co.jp', NULL, true, now(), now()),
    ('Mizuho Financial Group', bank_type_id, 'Japanese bank holding company', 'https://www.mizuhogroup.com', NULL, true, now(), now()),
    ('Postal Savings Bank of China', bank_type_id, 'Chinese commercial retail bank', 'https://www.psbc.com', NULL, true, now(), now()),
    ('Bank of Communications', bank_type_id, 'One of the largest banks in China', 'https://www.bankcomm.com', NULL, true, now(), now()),
    ('China Merchants Bank', bank_type_id, 'Chinese commercial bank', 'https://www.cmbchina.com', NULL, true, now(), now()),
    ('State Bank of India', bank_type_id, 'Indian multinational public sector bank and financial services company', 'https://www.sbi.co.in', NULL, true, now(), now()),
    ('HDFC Bank', bank_type_id, 'Indian banking and financial services company', 'https://www.hdfcbank.com', NULL, true, now(), now()),
    ('DBS Group', bank_type_id, 'Singaporean multinational banking and financial services corporation', 'https://www.dbs.com', NULL, true, now(), now()),
    ('Oversea-Chinese Banking Corporation', bank_type_id, 'Singaporean bank with regional operations', 'https://www.ocbc.com', NULL, true, now(), now()),
    ('United Overseas Bank', bank_type_id, 'Singaporean multinational banking corporation', 'https://www.uob.com.sg', NULL, true, now(), now()),
    ('KB Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.kbfg.com', NULL, true, now(), now()),
    ('Shinhan Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.shinhangroup.com', NULL, true, now(), now()),
    ('Hana Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.hanafn.com', NULL, true, now(), now()),
    ('Woori Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.woorifg.com', NULL, true, now(), now()),
    ('Industrial Bank of Korea', bank_type_id, 'South Korean commercial bank', 'https://www.ibk.co.kr', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - OCEANIA
    -- ========================================
    ('Commonwealth Bank', bank_type_id, 'Australian multinational bank', 'https://www.commbank.com.au', NULL, true, now(), now()),
    ('Westpac', bank_type_id, 'Australian bank and financial services provider', 'https://www.westpac.com.au', NULL, true, now(), now()),
    ('ANZ Group', bank_type_id, 'Australian multinational banking and financial services company', 'https://www.anz.com.au', NULL, true, now(), now()),
    ('National Australia Bank', bank_type_id, 'One of the four largest financial institutions in Australia', 'https://www.nab.com.au', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - LATIN AMERICA
    -- ========================================
    ('Itaú Unibanco', bank_type_id, 'Brazilian financial services company', 'https://www.itau.com.br', NULL, true, now(), now()),
    ('Banco do Brasil', bank_type_id, 'Brazilian financial services company', 'https://www.bb.com.br', NULL, true, now(), now()),
    ('Banco Bradesco', bank_type_id, 'Brazilian financial services company', 'https://www.bradesco.com.br', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - MIDDLE EAST & AFRICA
    -- ========================================
    ('Qatar National Bank', bank_type_id, 'Qatari multinational commercial bank', 'https://www.qnb.com', NULL, true, now(), now()),
    ('First Abu Dhabi Bank', bank_type_id, 'Largest bank in the United Arab Emirates', 'https://www.bankfab.com', NULL, true, now(), now()),
    ('Emirates NBD', bank_type_id, 'Banking group in the Middle East', 'https://www.emiratesnbd.com', NULL, true, now(), now()),
    ('Sberbank', bank_type_id, 'Russian banking and financial services company', 'https://www.sberbank.com', NULL, true, now(), now()),
    ('Standard Bank', bank_type_id, 'South African banking and financial services group', 'https://www.standardbank.com', NULL, true, now(), now()),

    -- ========================================
    -- BROKERS - GLOBAL
    -- ========================================
    ('Interactive Brokers', broker_type_id, 'American multinational brokerage firm offering direct access to stocks, options, futures, forex, and bonds', 'https://www.interactivebrokers.com', NULL, true, now(), now()),
    ('Charles Schwab', broker_type_id, 'American multinational financial services corporation providing brokerage and banking services', 'https://www.schwab.com', NULL, true, now(), now()),
    ('Fidelity Investments', broker_type_id, 'American multinational financial services corporation offering brokerage services', 'https://www.fidelity.com', NULL, true, now(), now()),
    ('TD Ameritrade', broker_type_id, 'American online broker (now part of Charles Schwab)', 'https://www.tdameritrade.com', NULL, true, now(), now()),
    ('E*TRADE', broker_type_id, 'American financial services company (now part of Morgan Stanley)', 'https://www.etrade.com', NULL, true, now(), now()),
    ('Robinhood', broker_type_id, 'American financial services company known for commission-free trades', 'https://www.robinhood.com', NULL, true, now(), now()),
    ('Vanguard', broker_type_id, 'American investment management company offering brokerage services', 'https://www.vanguard.com', NULL, true, now(), now()),
    ('Merrill Edge', broker_type_id, 'Electronic trading platform and investment advisory service offered by Bank of America', 'https://www.merrilledge.com', NULL, true, now(), now()),
    ('Webull', broker_type_id, 'Chinese-American electronic trading platform offering commission-free trading', 'https://www.webull.com', NULL, true, now(), now()),
    ('Saxo Bank', broker_type_id, 'Danish investment bank specializing in online trading and investment', 'https://www.home.saxo', NULL, true, now(), now()),
    ('IG Group', broker_type_id, 'British multinational online trading company', 'https://www.ig.com', NULL, true, now(), now()),
    ('Trading 212', broker_type_id, 'UK and Bulgarian fintech company offering commission-free trading', 'https://www.trading212.com', NULL, true, now(), now()),
    ('Degiro', broker_type_id, 'Dutch online discount broker', 'https://www.degiro.com', NULL, true, now(), now()),
    ('eToro', broker_type_id, 'Israeli social trading and multi-asset brokerage company', 'https://www.etoro.com', NULL, true, now(), now()),
    ('Plus500', broker_type_id, 'Israeli online trading company offering CFDs', 'https://www.plus500.com', NULL, true, now(), now()),
    ('XTB', broker_type_id, 'Polish brokerage house offering forex and CFD trading', 'https://www.xtb.com', NULL, true, now(), now()),
    ('Questrade', broker_type_id, 'Canadian online discount brokerage', 'https://www.questrade.com', NULL, true, now(), now()),
    ('Wealthsimple', broker_type_id, 'Canadian online investment management service', 'https://www.wealthsimple.com', NULL, true, now(), now()),
    ('CMC Markets', broker_type_id, 'UK-based financial services company offering online trading', 'https://www.cmcmarkets.com', NULL, true, now(), now()),
    ('OANDA', broker_type_id, 'Canadian corporation providing Internet-based forex trading and currency information services', 'https://www.oanda.com', NULL, true, now(), now()),
    ('Ally Invest', broker_type_id, 'American online brokerage subsidiary of Ally Financial', 'https://www.ally.com/invest', NULL, true, now(), now()),
    ('Tastytrade', broker_type_id, 'American financial network and online brokerage for options traders', 'https://www.tastytrade.com', NULL, true, now(), now()),
    ('SoFi', broker_type_id, 'American personal finance company offering brokerage services', 'https://www.sofi.com', NULL, true, now(), now()),
    ('Moomoo', broker_type_id, 'Investment and trading platform developed by Futu Holdings', 'https://www.moomoo.com', NULL, true, now(), now()),
    ('Public', broker_type_id, 'American social investing platform', 'https://www.public.com', NULL, true, now(), now()),

    -- ========================================
    -- CRYPTO EXCHANGES - GLOBAL
    -- ========================================
    ('Binance', crypto_exchange_type_id, 'Global cryptocurrency exchange providing platform for trading various cryptocurrencies', 'https://www.binance.com', NULL, true, now(), now()),
    ('Coinbase', crypto_exchange_type_id, 'American publicly traded cryptocurrency exchange platform', 'https://www.coinbase.com', NULL, true, now(), now()),
    ('Kraken', crypto_exchange_type_id, 'United States-based cryptocurrency exchange', 'https://www.kraken.com', NULL, true, now(), now()),
    ('Bitfinex', crypto_exchange_type_id, 'Cryptocurrency exchange owned and operated by iFinex', 'https://www.bitfinex.com', NULL, true, now(), now()),
    ('Bitstamp', crypto_exchange_type_id, 'Luxembourg-based cryptocurrency exchange', 'https://www.bitstamp.net', NULL, true, now(), now()),
    ('Gemini', crypto_exchange_type_id, 'American cryptocurrency exchange and custodian founded by the Winklevoss twins', 'https://www.gemini.com', NULL, true, now(), now()),
    ('KuCoin', crypto_exchange_type_id, 'Global cryptocurrency exchange providing trading services', 'https://www.kucoin.com', NULL, true, now(), now()),
    ('OKX', crypto_exchange_type_id, 'Seychelles-based cryptocurrency exchange offering spot and derivatives trading', 'https://www.okx.com', NULL, true, now(), now()),
    ('Huobi', crypto_exchange_type_id, 'Seychelles-based cryptocurrency exchange', 'https://www.huobi.com', NULL, true, now(), now()),
    ('Bybit', crypto_exchange_type_id, 'Cryptocurrency exchange offering derivatives trading', 'https://www.bybit.com', NULL, true, now(), now()),
    ('Crypto.com', crypto_exchange_type_id, 'Cryptocurrency platform offering exchange, wallet, and payment services', 'https://www.crypto.com', NULL, true, now(), now()),
    ('Gate.io', crypto_exchange_type_id, 'Cryptocurrency exchange providing spot and derivatives trading', 'https://www.gate.io', NULL, true, now(), now()),
    ('Bitget', crypto_exchange_type_id, 'Cryptocurrency exchange specializing in derivatives trading', 'https://www.bitget.com', NULL, true, now(), now()),
    ('MEXC', crypto_exchange_type_id, 'Global cryptocurrency exchange providing trading services', 'https://www.mexc.com', NULL, true, now(), now()),
    ('Upbit', crypto_exchange_type_id, 'South Korean cryptocurrency exchange', 'https://www.upbit.com', NULL, true, now(), now()),
    ('Bithumb', crypto_exchange_type_id, 'South Korean cryptocurrency exchange', 'https://www.bithumb.com', NULL, true, now(), now()),
    ('Bittrex', crypto_exchange_type_id, 'American cryptocurrency exchange', 'https://www.bittrex.com', NULL, true, now(), now()),
    ('Poloniex', crypto_exchange_type_id, 'Cryptocurrency exchange offering spot trading', 'https://www.poloniex.com', NULL, true, now(), now()),
    ('Coincheck', crypto_exchange_type_id, 'Japanese cryptocurrency exchange', 'https://www.coincheck.com', NULL, true, now(), now()),
    ('bitFlyer', crypto_exchange_type_id, 'Japanese cryptocurrency exchange', 'https://www.bitflyer.com', NULL, true, now(), now()),
    ('Bitso', crypto_exchange_type_id, 'Mexican cryptocurrency exchange platform', 'https://www.bitso.com', NULL, true, now(), now()),
    ('Mercado Bitcoin', crypto_exchange_type_id, 'Brazilian cryptocurrency exchange', 'https://www.mercadobitcoin.com.br', NULL, true, now(), now()),
    ('CoinDCX', crypto_exchange_type_id, 'Indian cryptocurrency exchange', 'https://www.coindcx.com', NULL, true, now(), now()),
    ('WazirX', crypto_exchange_type_id, 'Indian cryptocurrency exchange', 'https://www.wazirx.com', NULL, true, now(), now()),
    ('Luno', crypto_exchange_type_id, 'Cryptocurrency exchange and wallet provider operating in Africa and Europe', 'https://www.luno.com', NULL, true, now(), now()),

    -- ========================================
    -- CRYPTO WALLETS - BLOCKCHAIN NETWORKS
    -- ========================================
    ('Bitcoin Network', crypto_wallet_type_id, 'First decentralized cryptocurrency network enabling peer-to-peer transactions', 'https://bitcoin.org', NULL, true, now(), now()),
    ('Ethereum', crypto_wallet_type_id, 'Decentralized blockchain platform supporting smart contracts and dApps', 'https://ethereum.org', NULL, true, now(), now()),
    ('Binance Smart Chain', crypto_wallet_type_id, 'Blockchain network running parallel to Binance Chain with smart contract functionality', 'https://www.bnbchain.org', NULL, true, now(), now()),
    ('Polygon', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions', 'https://polygon.technology', NULL, true, now(), now()),
    ('Solana', crypto_wallet_type_id, 'High-performance blockchain supporting fast transactions and low fees', 'https://solana.com', NULL, true, now(), now()),
    ('Avalanche', crypto_wallet_type_id, 'Platform for decentralized applications and custom blockchain networks', 'https://www.avax.network', NULL, true, now(), now()),
    ('Cardano', crypto_wallet_type_id, 'Proof-of-stake blockchain platform with focus on security and sustainability', 'https://cardano.org', NULL, true, now(), now()),
    ('Polkadot', crypto_wallet_type_id, 'Multi-chain network enabling different blockchains to transfer messages and value', 'https://polkadot.network', NULL, true, now(), now()),
    ('Cosmos', crypto_wallet_type_id, 'Network of independent blockchains connected through Inter-Blockchain Communication protocol', 'https://cosmos.network', NULL, true, now(), now()),
    ('Arbitrum', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum using optimistic rollups', 'https://arbitrum.io', NULL, true, now(), now()),
    ('Optimism', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions', 'https://www.optimism.io', NULL, true, now(), now()),
    ('Base', crypto_wallet_type_id, 'Layer-2 blockchain built on Ethereum by Coinbase', 'https://base.org', NULL, true, now(), now()),
    ('Tron', crypto_wallet_type_id, 'Decentralized blockchain platform focused on content sharing and entertainment', 'https://tron.network', NULL, true, now(), now()),
    ('Ripple', crypto_wallet_type_id, 'Real-time gross settlement system and currency exchange network', 'https://ripple.com', NULL, true, now(), now()),
    ('Litecoin', crypto_wallet_type_id, 'Peer-to-peer cryptocurrency created as silver to Bitcoin''s gold', 'https://litecoin.org', NULL, true, now(), now()),
    ('Bitcoin Cash', crypto_wallet_type_id, 'Cryptocurrency fork of Bitcoin with larger block size', 'https://www.bitcoincash.org', NULL, true, now(), now()),
    ('Stellar', crypto_wallet_type_id, 'Open network for storing and moving money with focus on financial inclusion', 'https://www.stellar.org', NULL, true, now(), now()),
    ('Algorand', crypto_wallet_type_id, 'Pure proof-of-stake blockchain platform with focus on scalability and speed', 'https://www.algorand.com', NULL, true, now(), now()),
    ('Near Protocol', crypto_wallet_type_id, 'Sharded proof-of-stake blockchain focused on usability and scalability', 'https://near.org', NULL, true, now(), now()),
    ('Fantom', crypto_wallet_type_id, 'High-performance, scalable, and secure smart contract platform', 'https://fantom.foundation', NULL, true, now(), now()),
    ('Cronos', crypto_wallet_type_id, 'EVM-compatible blockchain built on Cosmos SDK by Crypto.com', 'https://cronos.org', NULL, true, now(), now()),
    ('Hedera', crypto_wallet_type_id, 'Public network using hashgraph consensus for high throughput and low fees', 'https://hedera.com', NULL, true, now(), now()),
    ('Aptos', crypto_wallet_type_id, 'Layer-1 blockchain focused on safety and scalability', 'https://aptoslabs.com', NULL, true, now(), now()),
    ('Sui', crypto_wallet_type_id, 'Layer-1 blockchain with focus on instant transaction finality', 'https://sui.io', NULL, true, now(), now()),

    -- ========================================
    -- PAYMENT PLATFORMS & DIGITAL WALLETS
    -- ========================================
    ('PayPal', other_type_id, 'American multinational financial technology company operating online payments system', 'https://www.paypal.com', NULL, true, now(), now()),
    ('Venmo', other_type_id, 'American mobile payment service owned by PayPal', 'https://www.venmo.com', NULL, true, now(), now()),
    ('Cash App', other_type_id, 'Mobile payment service developed by Block, Inc.', 'https://www.cash.app', NULL, true, now(), now()),
    ('Zelle', other_type_id, 'American peer-to-peer payments network owned by major banks', 'https://www.zellepay.com', NULL, true, now(), now()),
    ('Apple Pay', other_type_id, 'Mobile payment and digital wallet service by Apple', 'https://www.apple.com/apple-pay', NULL, true, now(), now()),
    ('Google Pay', other_type_id, 'Digital wallet platform and online payment system developed by Google', 'https://pay.google.com', NULL, true, now(), now()),
    ('Samsung Pay', other_type_id, 'Mobile payment and digital wallet service by Samsung Electronics', 'https://www.samsung.com/samsung-pay', NULL, true, now(), now()),
    ('Revolut', other_type_id, 'British financial technology company offering banking services, currency exchange, and trading', 'https://www.revolut.com', NULL, true, now(), now()),
    ('Wise', other_type_id, 'British financial technology company providing international money transfers', 'https://www.wise.com', NULL, true, now(), now()),
    ('N26', other_type_id, 'German neobank offering mobile banking services', 'https://www.n26.com', NULL, true, now(), now()),
    ('Monzo', other_type_id, 'British online bank providing mobile banking services', 'https://www.monzo.com', NULL, true, now(), now()),
    ('Starling Bank', other_type_id, 'British digital bank offering mobile-only current and business accounts', 'https://www.starlingbank.com', NULL, true, now(), now()),
    ('Chime', other_type_id, 'American financial technology company providing fee-free mobile banking services', 'https://www.chime.com', NULL, true, now(), now()),
    ('Stripe', other_type_id, 'American financial services and software company for online payment processing', 'https://www.stripe.com', NULL, true, now(), now()),
    ('Square', other_type_id, 'American financial services and digital payments company', 'https://www.squareup.com', NULL, true, now(), now()),
    ('Adyen', other_type_id, 'Dutch payment company allowing businesses to accept e-commerce payments', 'https://www.adyen.com', NULL, true, now(), now()),
    ('Klarna', other_type_id, 'Swedish fintech company providing online financial services including payment solutions', 'https://www.klarna.com', NULL, true, now(), now()),
    ('Affirm', other_type_id, 'American financial technology company offering point-of-sale installment loans', 'https://www.affirm.com', NULL, true, now(), now()),
    ('Afterpay', other_type_id, 'Australian financial technology company operating a buy now, pay later service', 'https://www.afterpay.com', NULL, true, now(), now()),
    ('Alipay', other_type_id, 'Chinese third-party mobile and online payment platform by Ant Group', 'https://www.alipay.com', NULL, true, now(), now()),
    ('WeChat Pay', other_type_id, 'Chinese mobile payment service by Tencent', 'https://www.wechat.com', NULL, true, now(), now()),
    ('Paytm', other_type_id, 'Indian digital payment and financial services company', 'https://www.paytm.com', NULL, true, now(), now()),
    ('PhonePe', other_type_id, 'Indian digital payment and financial services company', 'https://www.phonepe.com', NULL, true, now(), now()),
    ('M-Pesa', other_type_id, 'Mobile phone-based money transfer service founded in Kenya', 'https://www.vodafone.com/what-we-do/services/m-pesa', NULL, true, now(), now()),
    ('Mercado Pago', other_type_id, 'Argentine online payments platform by Mercado Libre', 'https://www.mercadopago.com', NULL, true, now(), now()),
    ('PicPay', other_type_id, 'Brazilian digital wallet and payment platform', 'https://www.picpay.com', NULL, true, now(), now()),
    ('GrabPay', other_type_id, 'Digital wallet service by Grab in Southeast Asia', 'https://www.grab.com/sg/pay', NULL, true, now(), now()),
    ('GCash', other_type_id, 'Filipino mobile wallet and payment service', 'https://www.gcash.com', NULL, true, now(), now()),
    ('Kakao Pay', other_type_id, 'South Korean mobile payment and digital wallet service', 'https://www.kakaopay.com', NULL, true, now(), now()),
    ('Line Pay', other_type_id, 'Mobile payment service integrated with Line messaging app', 'https://www.linepay.com', NULL, true, now(), now()),

    -- ========================================
    -- INVESTMENT FUNDS
    -- ========================================
    ('BlackRock', investment_fund_type_id, 'American multinational investment management corporation and world''s largest asset manager', 'https://www.blackrock.com', NULL, true, now(), now()),
    ('Vanguard Group', investment_fund_type_id, 'American investment management company known for low-cost index funds', 'https://www.vanguard.com', NULL, true, now(), now()),
    ('State Street Global Advisors', investment_fund_type_id, 'Investment management component of State Street Corporation', 'https://www.ssga.com', NULL, true, now(), now()),
    ('Fidelity Investments', investment_fund_type_id, 'American multinational financial services corporation', 'https://www.fidelity.com', NULL, true, now(), now()),
    ('BNY Mellon Investment Management', investment_fund_type_id, 'Investment management division of BNY Mellon', 'https://www.bnymellon.com', NULL, true, now(), now()),
    ('Amundi', investment_fund_type_id, 'French asset management company', 'https://www.amundi.com', NULL, true, now(), now()),
    ('PIMCO', investment_fund_type_id, 'American investment management firm focusing on fixed income', 'https://www.pimco.com', NULL, true, now(), now()),
    ('T. Rowe Price', investment_fund_type_id, 'American publicly owned global investment management firm', 'https://www.troweprice.com', NULL, true, now(), now()),
    ('Franklin Templeton', investment_fund_type_id, 'American multinational holding company providing investment management services', 'https://www.franklintempleton.com', NULL, true, now(), now()),
    ('Capital Group', investment_fund_type_id, 'American financial services company managing American Funds', 'https://www.capitalgroup.com', NULL, true, now(), now()),
    ('J.P. Morgan Asset Management', investment_fund_type_id, 'Asset management division of JPMorgan Chase', 'https://www.jpmorganassetmanagement.com', NULL, true, now(), now()),
    ('Invesco', investment_fund_type_id, 'American independent investment management company', 'https://www.invesco.com', NULL, true, now(), now()),
    ('Schroders', investment_fund_type_id, 'British multinational asset management company', 'https://www.schroders.com', NULL, true, now(), now()),
    ('Northern Trust Asset Management', investment_fund_type_id, 'American wealth management company', 'https://www.northerntrust.com', NULL, true, now(), now()),
    ('Nuveen', investment_fund_type_id, 'American asset management firm and subsidiary of TIAA', 'https://www.nuveen.com', NULL, true, now(), now()),

    -- ========================================
    -- PRIVATE EQUITY PLATFORMS
    -- ========================================
    ('Carta', private_equity_type_id, 'Platform for equity management, valuations, and cap table management for private companies', 'https://www.carta.com', NULL, true, now(), now()),
    ('EquityZen', private_equity_type_id, 'Marketplace connecting investors with employees of private companies for pre-IPO investments', 'https://www.equityzen.com', NULL, true, now(), now()),
    ('Forge Global', private_equity_type_id, 'Private securities marketplace providing access to pre-IPO investment opportunities', 'https://www.forgeglobal.com', NULL, true, now(), now()),
    ('SharesPost', private_equity_type_id, 'Marketplace for buying and selling shares in private companies', 'https://www.sharespost.com', NULL, true, now(), now()),
    ('Ledgy', private_equity_type_id, 'European equity management platform for startups and investors', 'https://www.ledgy.com', NULL, true, now(), now()),
    ('AngelList', private_equity_type_id, 'Platform for startups, angel investors, and job-seekers in tech companies', 'https://www.angellist.com', NULL, true, now(), now()),
    ('Republic', private_equity_type_id, 'Investment platform for startup investing, real estate, and crypto', 'https://www.republic.com', NULL, true, now(), now()),

    -- ========================================
    -- REAL ESTATE PLATFORMS
    -- ========================================
    ('Fundrise', real_estate_type_id, 'American financial technology company for real estate crowdfunding', 'https://www.fundrise.com', NULL, true, now(), now()),
    ('RealtyMogul', real_estate_type_id, 'Online real estate crowdfunding platform', 'https://www.realtymogul.com', NULL, true, now(), now()),
    ('CrowdStreet', real_estate_type_id, 'Online commercial real estate investing platform', 'https://www.crowdstreet.com', NULL, true, now(), now()),
    ('Arrived Homes', real_estate_type_id, 'Platform for investing in shares of rental homes', 'https://www.arrived.com', NULL, true, now(), now()),
    ('Roofstock', real_estate_type_id, 'Online marketplace for single-family rental homes', 'https://www.roofstock.com', NULL, true, now(), now()),
    ('EquityMultiple', real_estate_type_id, 'Commercial real estate investment platform', 'https://www.equitymultiple.com', NULL, true, now(), now()),
    ('Yieldstreet', real_estate_type_id, 'Alternative investment platform including real estate opportunities', 'https://www.yieldstreet.com', NULL, true, now(), now())

  ON CONFLICT (website) DO NOTHING;

END $$;
-- =========================================================================
-- SEED DATA: EVM chain institutions + native tokens
-- =========================================================================
-- Seed EVM chains (and TON) as institutions, then mark them integration-ready.
-- Institutions are keyed by website for idempotent seeding.

DO $$
DECLARE
    v_crypto_wallet_type_id uuid;
    v_ton_institution_id uuid;
BEGIN
    SELECT id INTO v_crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';

    INSERT INTO institutions (name, type_id, description, website, is_active) VALUES
      ('Ethereum',            v_crypto_wallet_type_id, 'Decentralized blockchain platform supporting smart contracts and dApps (Chain ID: 1)',           'https://ethereum.org',                          true),
      ('Abstract',            v_crypto_wallet_type_id, 'Abstract blockchain network (Chain ID: 2741)',                                                   'https://abstract.xyz',                          true),
      ('ApeChain',            v_crypto_wallet_type_id, 'ApeChain blockchain network (Chain ID: 33139)',                                                  'https://apechain.com',                          true),
      ('Arbitrum Nova',       v_crypto_wallet_type_id, 'Layer-2 scaling solution for gaming and social applications (Chain ID: 42170)',                  'https://nova.arbitrum.io',                      true),
      ('Arbitrum',            v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum using optimistic rollups (Chain ID: 42161)',               'https://arbitrum.io',                           true),
      ('Avalanche',           v_crypto_wallet_type_id, 'Platform for decentralized applications and custom blockchain networks (Chain ID: 43114)',       'https://www.avax.network',                      true),
      ('Base',                v_crypto_wallet_type_id, 'Layer-2 blockchain built on Ethereum by Coinbase (Chain ID: 8453)',                              'https://base.org',                              true),
      ('Berachain',           v_crypto_wallet_type_id, 'EVM-identical Layer 1 blockchain (Chain ID: 80094)',                                             'https://berachain.com',                         true),
      ('BitTorrent Chain',    v_crypto_wallet_type_id, 'Cross-chain scaling solution (Chain ID: 199)',                                                   'https://bt.io',                                 true),
      ('Blast',               v_crypto_wallet_type_id, 'Ethereum Layer 2 with native yield (Chain ID: 81457)',                                           'https://blast.io',                              true),
      ('Binance Smart Chain', v_crypto_wallet_type_id, 'Blockchain network with smart contract functionality (Chain ID: 56)',                            'https://www.bnbchain.org',                      true),
      ('Celo',                v_crypto_wallet_type_id, 'Mobile-first blockchain platform (Chain ID: 42220)',                                             'https://celo.org',                              true),
      ('Cronos',              v_crypto_wallet_type_id, 'EVM-compatible blockchain built on Cosmos SDK by Crypto.com (Chain ID: 25)',                     'https://cronos.org',                            true),
      ('Fantom',              v_crypto_wallet_type_id, 'High-performance, scalable, and secure smart contract platform (Chain ID: 250)',                 'https://fantom.foundation',                     true),
      ('Fraxtal',             v_crypto_wallet_type_id, 'Layer 2 blockchain by Frax Finance (Chain ID: 252)',                                             'https://frax.com',                              true),
      ('Gnosis',              v_crypto_wallet_type_id, 'EVM-compatible blockchain focused on payments and identity (Chain ID: 100)',                     'https://gnosis.io',                             true),
      ('HyperEVM',            v_crypto_wallet_type_id, 'High-performance EVM blockchain (Chain ID: 999)',                                                'https://hyperevm.com',                          true),
      ('Linea',               v_crypto_wallet_type_id, 'zkEVM Layer 2 network by ConsenSys (Chain ID: 59144)',                                           'https://linea.build',                           true),
      ('Mantle',              v_crypto_wallet_type_id, 'Layer 2 scaling solution with modular architecture (Chain ID: 5000)',                            'https://mantle.xyz',                            true),
      ('Moonbeam',            v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Polkadot (Chain ID: 1284)',                       'https://moonbeam.network',                      true),
      ('Moonriver',           v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Kusama (Chain ID: 1285)',                         'https://moonbeam.network/networks/moonriver',   true),
      ('Optimism',            v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions (Chain ID: 10)', 'https://www.optimism.io',                       true),
      ('Polygon',             v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum (Chain ID: 137)',                                          'https://polygon.technology',                    true),
      ('Ronin',               v_crypto_wallet_type_id, 'Ethereum sidechain for gaming (Chain ID: 747474)',                                               'https://roninchain.com',                        true),
      ('Sei',                 v_crypto_wallet_type_id, 'Layer 1 blockchain optimized for trading (Chain ID: 1329)',                                      'https://sei.io',                                true),
      ('Scroll',              v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 534352)',                                              'https://scroll.io',                             true),
      ('Sonic',               v_crypto_wallet_type_id, 'High-performance blockchain network (Chain ID: 146)',                                            'https://soniclabs.com',                         true),
      ('Sophon',              v_crypto_wallet_type_id, 'zkSync-based entertainment blockchain (Chain ID: 50104)',                                        'https://sophon.xyz',                            true),
      ('Swellchain',          v_crypto_wallet_type_id, 'Layer 2 blockchain for liquid staking (Chain ID: 1923)',                                         'https://swellnetwork.io',                       true),
      ('Taiko',               v_crypto_wallet_type_id, 'Decentralized zkEVM rollup (Chain ID: 167000)',                                                  'https://taiko.xyz',                             true),
      ('Unichain',            v_crypto_wallet_type_id, 'DeFi-focused Layer 2 by Uniswap (Chain ID: 130)',                                                'https://unichain.org',                          true),
      ('World Chain',         v_crypto_wallet_type_id, 'Optimism Superchain for verified humans (Chain ID: 480)',                                        'https://worldcoin.org/world-chain',             true),
      ('XDC Network',         v_crypto_wallet_type_id, 'Enterprise-ready hybrid blockchain (Chain ID: 50)',                                              'https://xdc.org',                               true),
      ('zkSync Era',          v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 324)',                                                 'https://zksync.io',                             true),
      ('opBNB',               v_crypto_wallet_type_id, 'Layer 2 scaling solution for BNB Chain (Chain ID: 204)',                                         'https://opbnb.bnbchain.org',                    true),
      ('TON',                 v_crypto_wallet_type_id, 'The Open Network - Layer-1 blockchain designed for mass adoption',                               'https://ton.org',                               true)
    ON CONFLICT (website) DO NOTHING;

    -- TON uses a non-EVM mapping (chain_id -15). Other chains get their mappings
    -- registered at runtime by IntegrationManager.
    SELECT id INTO v_ton_institution_id FROM institutions WHERE website = 'https://ton.org';
    IF v_ton_institution_id IS NOT NULL THEN
      INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
      VALUES (v_ton_institution_id, '-15', 'ton', true)
      ON CONFLICT (institution_id) DO NOTHING;
    END IF;

    -- Mark every seeded blockchain institution as integration-ready.
    UPDATE institutions SET has_integration = true
    WHERE website IN (
      'https://ethereum.org', 'https://abstract.xyz', 'https://apechain.com',
      'https://nova.arbitrum.io', 'https://arbitrum.io', 'https://www.avax.network',
      'https://base.org', 'https://berachain.com', 'https://bt.io', 'https://blast.io',
      'https://www.bnbchain.org', 'https://celo.org', 'https://cronos.org',
      'https://fantom.foundation', 'https://frax.com', 'https://gnosis.io',
      'https://hyperevm.com', 'https://linea.build', 'https://mantle.xyz',
      'https://moonbeam.network', 'https://moonbeam.network/networks/moonriver',
      'https://www.optimism.io', 'https://polygon.technology', 'https://roninchain.com',
      'https://sei.io', 'https://scroll.io', 'https://soniclabs.com', 'https://sophon.xyz',
      'https://swellnetwork.io', 'https://taiko.xyz', 'https://unichain.org',
      'https://worldcoin.org/world-chain', 'https://xdc.org', 'https://zksync.io',
      'https://opbnb.bnbchain.org', 'https://ton.org'
    );
END $$;

-- =========================================================================
-- SEED DATA: institution_blockchain_mappings
-- =========================================================================
-- Seed institution_blockchain_mappings for every blockchain institution seeded
-- by 0003_seed_institutions.sql + 0004_seed_evm_chains.sql.
--
-- Why: without a mapping row, IntegrationManager.detectWalletInstitutions
-- returns [] for that chain — which is exactly the bug that made wallet
-- imports land as "0 holdings across 0 accounts / No chains were detected".
-- Prior to this migration only the TON row existed (see 0004).
--
-- The upsert key is (institution_id), which is UNIQUE on the table. We look
-- each institution up by website (the idempotent key used by the seed
-- migrations); anything missing is silently skipped so this migration is
-- safe to re-run against partial states.

INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
SELECT i.id, m.chain_id, m.chain_type, true
FROM institutions i
JOIN (VALUES
    ('https://bitcoin.org',                         '0',      'bitcoin'),
    ('https://solana.com',                          '-2',     'solana'),
    ('https://tron.network',                        '-1',     'tron'),
    ('https://ethereum.org',                        '1',      'evm'),
    ('https://www.bnbchain.org',                    '56',     'evm'),
    ('https://polygon.technology',                  '137',    'evm'),
    ('https://www.avax.network',                    '43114',  'evm'),
    ('https://arbitrum.io',                         '42161',  'evm'),
    ('https://www.optimism.io',                     '10',     'evm'),
    ('https://base.org',                            '8453',   'evm'),
    ('https://fantom.foundation',                   '250',    'evm'),
    ('https://cronos.org',                          '25',     'evm'),
    ('https://nova.arbitrum.io',                    '42170',  'evm'),
    ('https://zksync.io',                           '324',    'evm'),
    ('https://scroll.io',                           '534352', 'evm'),
    ('https://linea.build',                         '59144',  'evm'),
    ('https://blast.io',                            '81457',  'evm'),
    ('https://mantle.xyz',                          '5000',   'evm'),
    ('https://opbnb.bnbchain.org',                  '204',    'evm'),
    ('https://gnosis.io',                           '100',    'evm'),
    ('https://celo.org',                            '42220',  'evm'),
    ('https://moonbeam.network',                    '1284',   'evm'),
    ('https://moonbeam.network/networks/moonriver', '1285',   'evm'),
    ('https://frax.com',                            '252',    'evm'),
    ('https://roninchain.com',                      '747474', 'evm'),
    ('https://xdc.org',                             '50',     'evm'),
    ('https://bt.io',                               '199',    'evm'),
    ('https://berachain.com',                       '80094',  'evm'),
    ('https://sei.io',                              '1329',   'evm'),
    ('https://soniclabs.com',                       '146',    'evm'),
    ('https://sophon.xyz',                          '50104',  'evm'),
    ('https://swellnetwork.io',                     '1923',   'evm'),
    ('https://taiko.xyz',                           '167000', 'evm'),
    ('https://unichain.org',                        '130',    'evm'),
    ('https://worldcoin.org/world-chain',           '480',    'evm'),
    ('https://abstract.xyz',                        '2741',   'evm'),
    ('https://apechain.com',                        '33139',  'evm'),
    ('https://hyperevm.com',                        '999',    'evm')
) AS m(website, chain_id, chain_type) ON i.website = m.website
ON CONFLICT (institution_id) DO UPDATE
  SET chain_id = EXCLUDED.chain_id,
      chain_type = EXCLUDED.chain_type,
      is_active = true,
      updated_at = now();

-- =========================================================================
-- SEED DATA: Independent Reserve institution
-- =========================================================================
-- Seed Independent Reserve (Australian crypto exchange) as an institution
-- and flip has_integration = true so the IntegrationManager + cron sync
-- pick it up. Keyed by website for idempotent re-seeds.

DO $$
DECLARE
    v_crypto_exchange_type_id uuid;
BEGIN
    SELECT id INTO v_crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';

    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Independent Reserve', v_crypto_exchange_type_id, 'Australian cryptocurrency exchange founded in 2013, AUSTRAC-registered and ISO 27001 certified', 'https://www.independentreserve.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    UPDATE institutions
       SET has_integration = true
     WHERE website = 'https://www.independentreserve.com';
END $$;

-- =========================================================================
-- SEED DATA: additional integrations (added 2026-04 and later)
-- =========================================================================
-- Seed / enable institutions for the second batch of API-key integrations:
-- regional crypto (BTC Markets, Bitfinex, Bitpanda, bitFlyer, Coincheck,
-- bitbank), brokers (Alpaca, T-Bank/Tinkoff, Tiger Brokers, Zerodha),
-- and neobanks (Mercury, Brex).

DO $$
DECLARE
    v_bank_type_id uuid;
    v_broker_type_id uuid;
    v_crypto_exchange_type_id uuid;
BEGIN
    SELECT id INTO v_bank_type_id FROM institution_types WHERE code = 'bank';
    SELECT id INTO v_broker_type_id FROM institution_types WHERE code = 'broker';
    SELECT id INTO v_crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';

    -- New crypto exchanges.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('BTC Markets', v_crypto_exchange_type_id, 'Australian cryptocurrency exchange founded in 2013', 'https://www.btcmarkets.net', NULL, true, now(), now()),
      ('Bitpanda', v_crypto_exchange_type_id, 'European cryptocurrency broker with crypto and fiat wallets', 'https://www.bitpanda.com', NULL, true, now(), now()),
      ('bitbank', v_crypto_exchange_type_id, 'Japanese cryptocurrency exchange focused on algorithmic trading', 'https://bitbank.cc', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- New brokers.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Alpaca', v_broker_type_id, 'American developer-first brokerage for stocks, options and crypto', 'https://alpaca.markets', NULL, true, now(), now()),
      ('T-Bank (Tinkoff)', v_broker_type_id, 'Russian online broker — T-Invest platform. Sanctions-sensitive; enablement gated per jurisdiction.', 'https://www.tbank.ru/invest/', NULL, true, now(), now()),
      ('Tiger Brokers', v_broker_type_id, 'Singapore / Hong Kong online broker offering US, HK, SG and AU equities', 'https://www.tigerbrokers.com', NULL, true, now(), now()),
      ('Zerodha', v_broker_type_id, 'Indian discount broker, largest by active clients', 'https://zerodha.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- New banks.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Mercury', v_bank_type_id, 'American neobank serving startups with business banking', 'https://mercury.com', NULL, true, now(), now()),
      ('Brex', v_bank_type_id, 'American corporate financial services company offering cash accounts and cards', 'https://www.brex.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- Flip has_integration on everything in this batch, including
    -- Bitfinex / bitFlyer / Coincheck which were already seeded by
    -- 0003_seed_institutions.sql.
    UPDATE institutions SET has_integration = true
     WHERE website IN (
       'https://www.btcmarkets.net',
       'https://www.bitfinex.com',
       'https://www.bitpanda.com',
       'https://bitflyer.com',
       'https://www.bitflyer.com',
       'https://coincheck.com',
       'https://www.coincheck.com',
       'https://bitbank.cc',
       'https://alpaca.markets',
       'https://www.tbank.ru/invest/',
       'https://www.tigerbrokers.com',
       'https://zerodha.com',
       'https://mercury.com',
       'https://www.brex.com'
     );
END $$;
