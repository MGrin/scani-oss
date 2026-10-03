-- 20261002020031 — holdings record who hid them
--
-- A holding the owner hid stops counting anywhere; one the closed-position
-- sweep hid keeps counting in value history, PnL, returns and flows (mgrin,
-- 2026-10-02, SC-1486). `is_hidden` alone could not tell them apart.
--
-- 'auto' is written only by the sweep. A hidden holding with no value here is
-- read as the owner's, which is exactly how every hidden holding was read
-- before this column existed, so a path that forgets it fails toward today.
--
-- Backfill: every holding hidden today is the owner's. Nothing recorded who
-- hid them, the balance-0 ones the sweep could have hidden were confirmed by
-- mgrin as his own (2026-10-02), and 'user' is how every hidden row was read
-- before this column existed, so no figure moves on the day this ships.
ALTER TABLE holdings ADD COLUMN hidden_by TEXT;

ALTER TABLE holdings ADD CONSTRAINT holdings_hidden_by_chk
  CHECK (hidden_by IS NULL OR hidden_by IN ('user', 'auto'));

UPDATE holdings SET hidden_by = 'user' WHERE is_hidden = true;
