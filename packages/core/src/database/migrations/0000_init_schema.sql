CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_account_id_group_id_unique" UNIQUE("account_id","group_id")
);
--> statement-breakpoint
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
CREATE TABLE "holding_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_groups_holding_id_group_id_unique" UNIQUE("holding_id","group_id")
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
CREATE TABLE "token_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"base_token_id" uuid NOT NULL,
	"price" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_prices_token_id_base_token_id_timestamp_unique" UNIQUE("token_id","base_token_id","timestamp")
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
	"icon_url" text,
	"provider_metadata" text DEFAULT '{}' NOT NULL,
	"is_scam_probability" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_symbol_type_id_unique" UNIQUE("symbol","type_id")
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
CREATE TABLE "user_integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"encrypted_credentials" jsonb NOT NULL,
	"credentials_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_integration_credentials_user_id_institution_id_unique" UNIQUE("user_id","institution_id")
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
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
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_type_id_account_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."account_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_apy_configs" ADD CONSTRAINT "holding_apy_configs_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_blockchain_mappings" ADD CONSTRAINT "institution_blockchain_mappings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_type_id_institution_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."institution_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_prices" ADD CONSTRAINT "token_prices_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_prices" ADD CONSTRAINT "token_prices_base_token_id_tokens_id_fk" FOREIGN KEY ("base_token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_type_id_token_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."token_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_base_currency_id_tokens_id_fk" FOREIGN KEY ("base_currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_holdings" ADD CONSTRAINT "vault_holdings_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_holdings" ADD CONSTRAINT "vault_holdings_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_currency_id_tokens_id_fk" FOREIGN KEY ("currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_groups_account_id" ON "account_groups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_groups_group_id" ON "account_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_institution_id" ON "accounts" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_user_institution" ON "accounts" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "idx_groups_user_id" ON "groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_groups_display_order" ON "groups" USING btree ("user_id","display_order");--> statement-breakpoint
CREATE INDEX "idx_holding_apy_configs_holding_id" ON "holding_apy_configs" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_holding_apy_configs_active" ON "holding_apy_configs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_holding_id" ON "holding_groups" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_group_id" ON "holding_groups" USING btree ("group_id");--> statement-breakpoint
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
CREATE INDEX "idx_token_prices_lookup" ON "token_prices" USING btree ("token_id","base_token_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_prices_timestamp" ON "token_prices" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_tokens_symbol" ON "tokens" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_tokens_type_id" ON "tokens" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_id" ON "user_integration_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_institution_id" ON "user_integration_credentials" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_institution" ON "user_integration_credentials" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_user_id" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_wallet_address" ON "user_wallets" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_vault_holdings_vault_id" ON "vault_holdings" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "idx_vault_holdings_holding_id" ON "vault_holdings" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_vaults_user_id" ON "vaults" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_vaults_user_active" ON "vaults" USING btree ("user_id","is_active");