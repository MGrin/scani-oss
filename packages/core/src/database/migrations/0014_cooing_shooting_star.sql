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
ALTER TABLE "institution_blockchain_mappings" ADD CONSTRAINT "institution_blockchain_mappings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_institution_blockchain_mappings_institution_id" ON "institution_blockchain_mappings" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_institution_blockchain_mappings_chain_id" ON "institution_blockchain_mappings" USING btree ("chain_id");