-- SC-381. A rule keyed on a payment DESCRIPTION matches one amount, once.
--
-- The first real rule was written minutes after SC-375 shipped, and it can
-- never fire again. Its shape, with a SYNTHETIC counterparty standing in for
-- the real one throughout this comment:
--
--   match_address  'pay 1234567.89 xyz to example recipient (dividends)'
--   verdict        not_a_disposal
--   note           'Example Recipient'
--
-- That is not an address. SC-375 was designed around chain addresses, and the
-- measurement says the only key it can actually reach is prose: every
-- populated `counterparty` in the ledger is free text a payment rail rendered,
-- and not one chain or exchange outflow has the column filled at all. The
-- prose then varies in exactly the wrong place — it leads with the amount,
-- which is per-transaction — so a dozen payments to two recipients carry a
-- dozen distinct descriptions and need a rule each.
--
-- The fix is NOT substring, prefix or fuzzy matching. SC-375 chose exact
-- full-string equality deliberately, against a key an ATTACKER can write to:
-- address poisoning sprays zero-value transfers to plant a lookalike in a
-- victim's history, which is what the zero-quantity rows the queue excludes
-- are. A `contains` rule over adversary-supplied text is a larger
-- hole than the one it closes.
--
-- So matching stays exact and what changes is what both sides are normalized
-- to. `transfer_counterparty_key` strips ONE anchored, fully-specified
-- preamble — `Pay <amount> <CCY> to ` — because those three tokens are the
-- per-transaction part of a payment-rail description and everything after them
-- is the recipient. It cannot make two different counterparties equal: the
-- text it compares is what the rail rendered after the preamble, byte for
-- byte, and two payments whose recipient text is identical are payments to the
-- same recipient.
--
-- Verified against every counterparty string in the ledger. The strings below
-- are SYNTHETIC stand-ins of the same shapes, never the real values: it
-- collapses `Pay 500.00 USD to Example Recipient (Dividends)` and its siblings
-- onto one key, collapses a second recipient's rows onto one, and leaves every
-- string that does not open with the preamble — `Deposit to account <number>`,
-- `INVOICE <n> , EXAMPLE LTD`, `Fee for payout <reference>` — untouched.
-- No chain address is affected: none begins with `Pay `.
--
-- What is deliberately NOT stripped is the `(Dividends)` suffix. It is a
-- purpose the user chose and part of who is being paid for what — merging it
-- with `(Loan)` would rule on transfers they may want ruled differently. The
-- `(Dividents)` typo in the source data therefore keys separately, and that is
-- correct: nearly every payment row collapses onto one of two keys, and the
-- typos stay their own. Perfect coverage was never the ask.
--
-- IMMUTABLE and in the database rather than in TypeScript, because the whole
-- failure mode of a derived key is the two ends drifting apart. SC-376's
-- lesson is one predicate, two call sites; here there is one implementation
-- and four call sites — the rule engine's join, the authoring path that copies
-- the key off the caller's own row, the affected-row count, and the backfill
-- at the bottom of this file. A second copy in application code is how a rule
-- silently stops matching.
CREATE OR REPLACE FUNCTION transfer_counterparty_key(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT nullif(
    regexp_replace(
      lower(trim(raw)),
      -- Anchored at the start and complete: the literal `pay`, an amount, a
      -- three-letter currency, and the literal `to`. An unanchored or partial
      -- pattern would be the substring match this ticket exists to refuse.
      '^pay\s+[0-9][0-9,]*(\.[0-9]+)?\s+[a-z]{3}\s+to\s+',
      ''
    ),
    ''
  );
$$;

-- `match_address` was never an address in any row this table has ever held,
-- and leaving the name would tell the next reader the value is a hex string
-- they may parse as one. The column holds a normalized counterparty identity:
-- an EIP-55 address lowercased for chain rows, a recipient for payment-rail
-- rows.
ALTER TABLE "transfer_review_rules" RENAME COLUMN "match_address" TO "match_counterparty";

ALTER INDEX IF EXISTS "transfer_review_rules_active_address_uq"
  RENAME TO "transfer_review_rules_active_counterparty_uq";

-- The rules already written are real data a user authored, so they are
-- re-keyed rather than orphaned or revoked. The function is idempotent — its
-- output no longer begins with the preamble, so applying it twice is applying
-- it once — which is what makes running this over every row safe.
--
-- `rn = 1` because the partial unique index allows one active rule per
-- (user, key) and two rules whose descriptions differ only by amount now
-- normalize onto the same key. The oldest wins; any later sibling keeps its
-- literal key and goes on matching exactly the row it always matched, which is
-- a rule that does less than intended rather than a row that disappeared. At
-- the time this shipped it collided with nothing: there was a single rule.
WITH rekeyed AS (
  SELECT
    id,
    transfer_counterparty_key(match_counterparty) AS key,
    row_number() OVER (
      PARTITION BY user_id, transfer_counterparty_key(match_counterparty)
      ORDER BY created_at
    ) AS rn
  FROM "transfer_review_rules"
  WHERE revoked_at IS NULL
)
UPDATE "transfer_review_rules" r
SET match_counterparty = rekeyed.key
FROM rekeyed
WHERE r.id = rekeyed.id
  AND rekeyed.rn = 1
  AND rekeyed.key IS NOT NULL
  AND r.match_counterparty <> rekeyed.key;
