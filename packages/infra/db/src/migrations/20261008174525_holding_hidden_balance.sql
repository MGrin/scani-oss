-- 20261008174525 — holding hidden balance
-- Foundation A5, #9. A delete hides a feed holding, and the hide is its owner's:
-- no feed shows it again. So the balance it was hidden at is kept, and a hidden
-- holding that later holds more is named on the data-quality page instead of
-- sitting outside every total unseen. Text, as `balance` is. A row hidden
-- before this column existed has NULL here, read as zero.

SET LOCAL lock_timeout = '5s';

ALTER TABLE holdings ADD COLUMN hidden_balance text;
