-- 20261009115442 — feed input windows shape
-- SC-1665. A balance sync and a ledger read write windows on the same input,
-- and neither's extent says which it was: an IBKR balance window spans a range,
-- and an empty ledger run with no start is an instant. The ledger read-through
-- point is the newest 'transaction-run' window, so each window keeps the shape
-- it was declared with. Older rows stay NULL: their shape is not recoverable,
-- except an upload's.

SET LOCAL lock_timeout = '5s';

ALTER TABLE feed_input_windows
  ADD COLUMN shape text
  CHECK (shape IN ('balance-snapshot', 'statement-upload', 'transaction-run'));

UPDATE feed_input_windows SET shape = 'statement-upload' WHERE upload_ref IS NOT NULL;
