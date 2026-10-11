-- 20261010112916 — one payee key for ledger rows (SC-1695)
-- A category a person picks spreads to their other rows with the same key, in
-- one indexed UPDATE. The key is defined here and nowhere else, as
-- transfer_counterparty_key is, so no TypeScript copy can drift from it.
--
-- The counterparty when there is one; otherwise the description with its digit
-- runs removed, so card numbers and dates do not split one shop into many.
-- Then the vendor rules: lower case, one card-processor prefix, punctuation to
-- spaces, the legal form (the same list as vendors.match_key). Unlike
-- vendorMatchKey it keeps letters outside ASCII, so a Cyrillic payee has a key.
-- Under three characters there is no key.
--
-- The text is collated "und-x-icu" so lower() and [[:alnum:]] read Unicode
-- whatever the database locale. Under a plain C locale (CI's, and possibly a
-- self-hoster's) both are ASCII-only, and a Cyrillic payee had no key at all.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION transaction_payee_key(counterparty text, description text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN char_length(k) >= 3 THEN k END
  FROM (
    SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      btrim(regexp_replace(
        regexp_replace(lower(src), '^(sq \*|sq\*|sp \*|sp\*|tst\*|tst \*|pp\*|pp \*|paypal \*)', ''),
        '[^[:alnum:]]+', ' ', 'g')),
      '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''), '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''), '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', ''), '\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$', '') AS k
    FROM (
      SELECT coalesce(nullif(btrim(counterparty), ''), regexp_replace(description, '[0-9]+', ' ', 'g'))
        COLLATE "und-x-icu" AS src
    ) s
  ) x
$$;

CREATE INDEX idx_holding_tx_user_payee_key
  ON holding_transactions (user_id, transaction_payee_key(counterparty, description));
