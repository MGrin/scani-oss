-- SC-674. A recurring-payment suggestion the user dismissed, so it stays
-- dismissed.
--
-- Suggestions are derived at read time from the user's own outflows and are
-- never stored; only the user's "no" is. It is keyed on the payee's match key
-- and the currency, not on the amount or the transactions it matched, because
-- the next sync brings a new transaction and a slightly different median, and
-- a dismissal keyed on either would come back the next month (mgrin's ruling
-- via the Operator, 2026-09-19: "a dismissed suggestion stays dismissed").
CREATE TABLE IF NOT EXISTS "recurring_suggestion_dismissals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "counterparty_key" text NOT NULL,
  "currency_token_id" uuid NOT NULL REFERENCES "tokens"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recurring_suggestion_dismissals_user_payee_currency_unique"
    UNIQUE ("user_id", "counterparty_key", "currency_token_id")
);
