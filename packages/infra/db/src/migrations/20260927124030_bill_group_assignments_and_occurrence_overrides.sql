ALTER TABLE payments ADD COLUMN schedule_effective_from date;
ALTER TABLE payment_occurrences ADD COLUMN groups_overridden boolean NOT NULL DEFAULT false;
ALTER TABLE payment_occurrences ADD COLUMN amount_overridden boolean NOT NULL DEFAULT false;
CREATE TABLE payment_groups (
 payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
 group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 CONSTRAINT payment_groups_unique UNIQUE(payment_id, group_id)
);
CREATE TABLE payment_occurrence_groups (
 occurrence_id uuid NOT NULL REFERENCES payment_occurrences(id) ON DELETE CASCADE,
 group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 CONSTRAINT payment_occurrence_groups_unique UNIQUE(occurrence_id, group_id)
);
