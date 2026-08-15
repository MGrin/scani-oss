-- Vendor resolution was exact-only: equality on `normalized_name`, then a
-- verbatim `vendor_aliases.raw_name` lookup. So "Hetzner Online GmbH" and
-- "Hetzner Online" were two vendors, and so were "Fly.io" and "Fly.io, Inc."
-- — every extractor run that phrased the legal form differently silently
-- minted a duplicate the user then had to merge by hand.
--
-- `match_key` is `normalized_name` with the trailing legal form removed, which
-- turns both of those pairs into an EQUALITY match rather than a guess. The
-- trigram index on top of it is what catches the rest — typos and truncation —
-- as scored CANDIDATES; `@scani/domain/lib/vendor-match-key` documents why the
-- silent-reuse threshold sits at 0.85 and the suggest floor at 0.45.
--
-- GENERATED, not written by the application. A plain NOT NULL column would
-- have to be populated by every INSERT into `vendors`, which makes the column
-- a coordination problem: any writer that doesn't know about it fails, and any
-- writer that computes it slightly differently poisons matching silently.
-- Deriving it in the database removes both — there is one definition, it
-- cannot go stale, and `normalized_name` is NOT NULL so the result never is.
--
-- The four nested `regexp_replace` calls mirror `vendorMatchKey`'s own
-- four-pass cap, so a name like "Muster GmbH & Co. KG" (three strips) resolves
-- identically on both sides. That parity is asserted against this live column
-- in `VendorRepository.test.ts` — it is the one place the two implementations
-- can drift, so it is tested rather than trusted.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
ALTER TABLE vendors DROP COLUMN IF EXISTS match_key;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN match_key text NOT NULL GENERATED ALWAYS AS (
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          normalized_name,
          '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''),
        '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''),
      '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''),
    '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', '')
) STORED;
--> statement-breakpoint
-- GIN rather than GiST: this index only ever answers `%` / `similarity()`
-- containment probes, never a k-NN `<->` ordering, and GIN is the faster of the
-- two for exactly that.
CREATE INDEX IF NOT EXISTS idx_vendors_match_key_trgm ON vendors USING gin (match_key gin_trgm_ops);
--> statement-breakpoint
-- The equality tier — "Hetzner Online GmbH" resolving to "Hetzner Online" — has
-- to stay as cheap as the two exact tiers it sits behind, and a trigram index
-- cannot serve a plain `=`.
CREATE INDEX IF NOT EXISTS idx_vendors_user_match_key ON vendors (user_id, match_key);
