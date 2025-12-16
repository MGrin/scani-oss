-- Seed schedule types
INSERT INTO schedule_types (id, code, name, description, display_order, is_active, created_at, updated_at)
VALUES 
  (gen_random_uuid(), 'income_allocation', 'Income Allocation', 'Recurring pattern for allocating incoming income across accounts', 1, true, now(), now()),
  (gen_random_uuid(), 'subscription', 'Subscription', 'Recurring subscription payments', 2, true, now(), now()),
  (gen_random_uuid(), 'payment', 'Payment', 'Recurring payment obligations', 3, true, now(), now()),
  (gen_random_uuid(), 'other', 'Other', 'Other types of recurring monetary movements', 4, true, now(), now())
ON CONFLICT (code) DO NOTHING;

-- Seed schedule step types
INSERT INTO schedule_step_types (id, code, name, description, display_order, is_active, created_at, updated_at)
VALUES 
  (gen_random_uuid(), 'inflow', 'Inflow', 'Money coming into a holding from an external source', 1, true, now(), now()),
  (gen_random_uuid(), 'outflow', 'Outflow', 'Money going out of a holding to an external destination', 2, true, now(), now()),
  (gen_random_uuid(), 'transfer', 'Transfer', 'Transfer of the same token between two holdings', 3, true, now(), now()),
  (gen_random_uuid(), 'conversion', 'Conversion', 'Conversion from one token to another between holdings', 4, true, now(), now())
ON CONFLICT (code) DO NOTHING;
