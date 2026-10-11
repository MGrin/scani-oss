-- 20261007111510 — engine shadow runs take the value kind
-- Foundation A4 (SC-1610). The nightly shadow gains a `value` kind: each
-- visible holding's cached `value_base` beside the live valuation at the run's
-- instant. `price` stays allowed, because the runs it recorded before A3
-- retired it are kept until pruned.
SET LOCAL lock_timeout = '5s';

ALTER TABLE engine_shadow_runs DROP CONSTRAINT IF EXISTS engine_shadow_runs_kind_chk;
ALTER TABLE engine_shadow_runs
  ADD CONSTRAINT engine_shadow_runs_kind_chk CHECK (kind IN ('balance', 'price', 'value'));
