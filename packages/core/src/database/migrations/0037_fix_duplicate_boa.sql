-- Remove unused duplicate Bank of America entry
-- Keep b8ce73c3 (has 2 accounts referencing it), remove 8b292cfc (unused)
DELETE FROM institutions WHERE id = '8b292cfc-666b-4b3a-9140-70a85dcd9ca4';
