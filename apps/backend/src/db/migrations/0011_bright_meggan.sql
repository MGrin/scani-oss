ALTER TABLE "users"
ADD COLUMN "base_currency_id" uuid;

--> statement-breakpoint
-- Update existing users to reference the USD token by default
UPDATE users
SET
  base_currency_id = (
    SELECT
      tokens.id
    FROM
      tokens
      JOIN token_types ON tokens.type_id = token_types.id
    WHERE
      tokens.symbol = 'USD'
      AND token_types.code = 'fiat'
    LIMIT
      1
  );

-- For users who had EUR as base currency (if any), update to EUR token
UPDATE users
SET
  base_currency_id = (
    SELECT
      tokens.id
    FROM
      tokens
      JOIN token_types ON tokens.type_id = token_types.id
    WHERE
      tokens.symbol = users.base_currency
      AND token_types.code = 'fiat'
    LIMIT
      1
  )
WHERE
  users.base_currency != 'USD'
  AND EXISTS (
    SELECT
      1
    FROM
      tokens
      JOIN token_types ON tokens.type_id = token_types.id
    WHERE
      tokens.symbol = users.base_currency
      AND token_types.code = 'fiat'
  );

ALTER TABLE "users" ADD CONSTRAINT "users_base_currency_id_tokens_id_fk" FOREIGN KEY ("base_currency_id") REFERENCES "public"."tokens" ("id") ON DELETE restrict ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "users"
DROP COLUMN "base_currency";