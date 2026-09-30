-- SC-1408 — a payee can be in a group, as a rule covering every bill with that
-- payee, including bills added later. The payee side of `account_groups`
-- (SC-386), with `payment_group_exclusions` as the one bill's opt-out, the
-- payee side of `holding_group_exclusions`. Additive: two new tables, no
-- existing row read or changed.
CREATE TABLE vendor_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_groups_unique UNIQUE (vendor_id, group_id)
);
CREATE INDEX idx_vendor_groups_group_id ON vendor_groups (group_id);

CREATE TABLE payment_group_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_group_exclusions_unique UNIQUE (payment_id, group_id)
);
CREATE INDEX idx_payment_group_exclusions_group_id ON payment_group_exclusions (group_id);
