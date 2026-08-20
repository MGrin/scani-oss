-- SC-277. `holdings.source` records which system wrote a row. It does not
-- record whether anyone ever chose to hold it, and on a public chain that is
-- the whole question: anyone can push tokens at an address.
--
-- Two paths create a wallet holding and both write `source = 'blockchain'`:
--   * the wallet import, whose phase-2 `importFromReview` writes only the
--     snapshots the user kept (the ones they dropped land in
--     `holding_exclusions`), and
--   * the hourly `wallet-balances` cron, which runs with `updateOnly: false`
--     and auto-discovers whatever arrived since, asking nobody.
-- Afterwards the two rows are identical. "I bought this" and "this was pushed
-- at me" are the same record.
--
-- Deliberately on `holdings` and not on `tokens`. A token row is global and
-- shared by every user; arrival is a fact about ONE user's position. The same
-- contract that reaches a stranger as spam reaches its deployer as inventory.

ALTER TABLE "holdings"
  ADD COLUMN IF NOT EXISTS "arrival" text NOT NULL DEFAULT 'unattributed';

COMMENT ON COLUMN "holdings"."arrival" IS
  'user_confirmed = a human was shown this position or authored it; auto_discovered = a balance sync created it and nobody was asked; unattributed = we cannot say (predates the column). A signal, never a verdict. SC-277.';

-- The TS union is the design constraint; this is the one that survives a
-- hand-written UPDATE. A fourth value would reach consumers that handle three.
ALTER TABLE "holdings"
  DROP CONSTRAINT IF EXISTS "holdings_arrival_check";
ALTER TABLE "holdings"
  ADD CONSTRAINT "holdings_arrival_check"
  CHECK ("arrival" IN ('user_confirmed', 'auto_discovered', 'unattributed'));

-- BACKFILL — one-time historical inference, never used again. Every row
-- written after this migration is stamped at its own write site by the path
-- that created it; nothing recomputes this predicate on a timer.
--
-- The predicate is "a blockchain holding created more than a day after its
-- account". It is sound because no other code path can produce one:
-- `RefreshAccountBalanceUseCase` sets `updateOnly: true` on the wallet branch
-- precisely so a manual refresh cannot re-expand a curated set, and the import
-- creates its holdings inside the same request that creates the account. The
-- hourly cron is what is left.
--
-- Measured against production before writing this file:
--
--   source            at-import(<=1h)  1h..1d  post-import(>1d)  total
--   blockchain                     23       0                17     40
--   manual                         20       0                 1     21
--   import_ibkr                    16       0                 0     16
--   import_bybit                    4       0                 0      4
--   import_kraken                   4       0                 0      4
--   import_airwallex                1       0                 0      1
--
-- The two blockchain clusters do not touch and there is nothing between them:
-- the widest at-import gap is 59m47s and the narrowest post-import gap is
-- 4d17h, a factor of 113. Rows flagged: 17, across 2 users and 3 accounts.
-- At-import rows flagged by mistake: 0 — not "few", zero, and no threshold
-- between one hour and four days changes that number.
--
-- Two further checks, because a late row could in principle be a second import
-- rather than the cron. No confirmed `wallet-import` job lands within +/-30
-- minutes of any of the 17, and all 17 were written between :00:59 and :01:22
-- past an hour — the cron's schedule, not a person's.
--
-- `manual`'s one post-import row is not touched: the source filter excludes
-- it, and correctly — a manual row is user-authored whenever it was written.
-- `sync_exchange_balances` has never created a holding in production (0 rows),
-- so the exchange cron contributes nothing here despite also running with
-- `updateOnly: false`.
UPDATE "holdings" h
SET "arrival" = 'auto_discovered'
FROM "accounts" a
WHERE a."id" = h."account_id"
  AND h."source" = 'blockchain'
  AND h."created_at" > a."created_at" + interval '1 day';

-- The remaining 69 rows stay `unattributed` on purpose. The evidence above
-- proves which rows a machine created; it does not prove a human picked any
-- specific one of the rest, and `unattributed` is the value that says so.
-- Backfilling them to `user_confirmed` would be an inference dressed as a
-- record, and it is the direction that fails badly: it would tell a future
-- consumer that a position was reviewed when nobody ever saw it.
