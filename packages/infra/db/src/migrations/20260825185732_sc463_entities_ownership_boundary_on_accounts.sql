-- 20260825185732 — sc463 entities ownership boundary on accounts
--
-- Two sets of books with one owner: a contractor's own money and their limited
-- company's (SC-463). The boundary is a scalar on `accounts`, not a group.
--
-- SC-463 asked first whether a group could carry this. It cannot, and the
-- reason is not that groups lack exclusivity — they REFUSE it.
-- `GroupValuationService` counts a holding fully in every group that claims
-- it, pinned by a named test ("a holding reached by two groups counts fully in
-- both"), because the code it replaced silently shorted the second group by a
-- whole position (SC-385). `AssetAllocationService` says it outright: the
-- group cut is "the one dimension whose buckets overlap". An ownership
-- boundary needs the opposite semantic — a partition — or the two sets of
-- books double-count where they overlap.
--
-- `holdings.account_id` is NOT NULL, so one nullable column here partitions
-- every holding for free: no junction table, no membership resolution, no
-- veto, and no second top-level dimension threaded through the domain.
--
-- NOT tax output. SC-90 stays parked
-- (`docs/technical/2026-08-14_why-no-tax-statement.md`) and this does not
-- reopen it.
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entities_user_id_name_unique UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities (user_id);

-- No `is_active`, and its absence is deliberate rather than an omission.
-- `groups` has one, and a group deactivated under a holding drops that holding
-- into `ungrouped` with no event — `GroupValuationService` does exactly that
-- and has a test for it. Tolerable for a label. For an ownership boundary the
-- same mechanic would silently move assets from the company's books onto the
-- owner's, which is the class of silent failure this whole ticket is about.
-- The only ways out of an entity are an explicit reassignment and deleting the
-- entity, and the FK below makes the second one explicit too.

-- NULL is a REAL state: "not assigned to any entity". Every existing account
-- gets it, and that is the correct backfill — nobody has drawn this boundary
-- yet, and inventing one for them would assert an ownership fact we do not
-- have. It is rendered as its own bucket beside the entities rather than
-- folded into one, so `sum(entities) + unassigned = combined` is an exact
-- identity and no account can be absorbed into a boundary nobody put it in.
--
-- ON DELETE SET NULL, not CASCADE. Deleting an entity must not delete the
-- accounts inside it and must not take their holdings — that would destroy
-- real financial history to remove a label. The accounts fall back to
-- unassigned, where they are visible in their own bucket rather than silently
-- joining the other entity.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE SET NULL;

-- The read every per-entity total makes: one user's accounts, cut by entity.
CREATE INDEX IF NOT EXISTS idx_accounts_user_entity ON accounts (user_id, entity_id);
