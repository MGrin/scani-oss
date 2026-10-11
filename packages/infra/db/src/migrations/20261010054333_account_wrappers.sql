-- 20261010054333 — account wrappers
-- SC-1645. An asset account may carry a wrapper (ISA, SIPP, Roth IRA, …), and
-- each wrapper sits in one of four buckets. The v1 codes are Sure's US, UK,
-- CA, AU, EU and generic subtypes (we-promise/sure @ 196355b1,
-- app/models/investment.rb); India's are SC-1673. A lookup table rather than a
-- CHECK, so a new wrapper is a seed row. NULL on the account means general.

SET LOCAL lock_timeout = '5s';

CREATE TABLE account_wrappers (
  code text PRIMARY KEY,
  region text CONSTRAINT account_wrappers_region_chk CHECK (region IN ('us', 'uk', 'ca', 'au', 'eu')),
  treatment text NOT NULL
    CONSTRAINT account_wrappers_treatment_chk CHECK (treatment IN ('general', 'deferred', 'exempt', 'advantaged')),
  display_order real NOT NULL
);

INSERT INTO account_wrappers (code, region, treatment, display_order) VALUES
  ('brokerage', 'us', 'general', 1),
  ('cash_management', 'us', 'general', 2),
  ('401k', 'us', 'deferred', 3),
  ('roth_401k', 'us', 'exempt', 4),
  ('403b', 'us', 'deferred', 5),
  ('457b', 'us', 'deferred', 6),
  ('tsp', 'us', 'deferred', 7),
  ('ira', 'us', 'deferred', 8),
  ('roth_ira', 'us', 'exempt', 9),
  ('sep_ira', 'us', 'deferred', 10),
  ('simple_ira', 'us', 'deferred', 11),
  ('529_plan', 'us', 'advantaged', 12),
  ('hsa', 'us', 'advantaged', 13),
  ('ugma', 'us', 'general', 14),
  ('utma', 'us', 'general', 15),
  ('isa', 'uk', 'exempt', 16),
  ('lisa', 'uk', 'exempt', 17),
  ('sipp', 'uk', 'deferred', 18),
  ('workplace_pension_uk', 'uk', 'deferred', 19),
  ('tfsa', 'ca', 'exempt', 20),
  ('rrsp', 'ca', 'deferred', 21),
  ('non_registered', 'ca', 'general', 22),
  ('fhsa', 'ca', 'exempt', 23),
  ('rdsp', 'ca', 'advantaged', 24),
  ('resp', 'ca', 'advantaged', 25),
  ('dpsp', 'ca', 'deferred', 26),
  ('prpp', 'ca', 'deferred', 27),
  ('lira', 'ca', 'deferred', 28),
  ('rrif', 'ca', 'deferred', 29),
  ('lif', 'ca', 'deferred', 30),
  ('lrif', 'ca', 'deferred', 31),
  ('prif', 'ca', 'deferred', 32),
  ('rlif', 'ca', 'deferred', 33),
  ('super', 'au', 'deferred', 34),
  ('smsf', 'au', 'deferred', 35),
  ('assurance_vie', 'eu', 'advantaged', 36),
  ('pea', 'eu', 'advantaged', 37),
  ('pillar_3a', 'eu', 'deferred', 38),
  ('riester', 'eu', 'deferred', 39),
  ('pension', NULL, 'deferred', 40),
  ('retirement', NULL, 'deferred', 41),
  ('mutual_fund', NULL, 'general', 42),
  ('gold', NULL, 'general', 43),
  ('angel', NULL, 'general', 44),
  ('trust', NULL, 'general', 45),
  ('other', NULL, 'general', 46)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE accounts ADD COLUMN wrapper text REFERENCES account_wrappers(code) ON DELETE RESTRICT;
