-- 20261008134839 — engine writer guard enabled
-- Foundation A5, PR-3 (decision D-1). The engine is now the only writer of
-- `holdings.balance`, `value_base` and `value_priced_at`: every caller goes
-- through `HoldingCacheWriter`, which writes inside `asEngineCalculator`. From
-- here the guard refuses any other writer of those columns with SQLSTATE SCE01.

SET LOCAL lock_timeout = '5s';

ALTER TABLE holdings ENABLE TRIGGER holdings_engine_writer_guard;
