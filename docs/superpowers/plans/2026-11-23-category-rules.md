# SC-1652 Saved Category Rules Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task only after the parent assigns an isolated OSS worktree. No workers or implementation are authorized in the current shared checkout.

**Goal:** Save exact-payee category rules and explicitly preview, apply and undo them over bounded outgoing fiat rows.

**Architecture:** TransactionCategoryRuleService owns the matching/write/undo interface; a repository contains the SQL and transactional locks. Two owner-scoped tables store rule definitions and bounded preview/application records. Existing category/learning/AI/ingest code remains its own mechanism; custom writes never call the personal-pick spread path.

**Tech Stack:** Bun, TypeScript/tsgo, Drizzle/PostgreSQL, typedi, tRPC/Zod, React and existing UI/i18n. No new dependencies.

**Spec:** [accepted design](../specs/2026-11-23-category-rules-design.md), revision 2. This plan supersedes plan-v1.md and addresses review-input.md. Revision 2 accepted for implementation.

## Global constraints

- OSS first: use parent-assigned MGrin/scani-oss worktree; read its instructions and confirm every named existing path before editing. The inspected private revision is 4ef822cc9, not the implementation branch.
- Exact normalized payee, one required owned account, one category action. At most 100 saved rules. Unique (user,account,payee); no global rules/overrides. Disabled rules do not match; duplicate same-scope keys refuse.
- Preview requires one owned account plus [from,to); 501 matching eligible rows refuses, <=500 may preview. Preview expires after 15 minutes. At most 3 outstanding previews and20 retained applications per owner. Only reviewed IDs change; new imports await another preview.
- Authority: person/cleared and import protected; custom_rule above learned/AI/kind/null. Income/transfers/trades are excluded; category assignment never changes financial/classification evidence.
- Two tables, no worker/job/cron/new library. All definition writes, apply and undo are transactional, bounded and owner-scoped. Stale/conflicting operations are all-or-nothing. Rule actions use only categoryId/categorySetBy/updatedAt.
- Rule/run locks share one per-user advisory key (`category-rules:` + userId); exact versioned projection fields and table lock order are normative in design.md. Parent caches/timestamps are excluded; PostgreSQL transaction timestamp precision is retained. 3-second lock/statement timeout.
- Shared source, no private flag/billing/analytics imports. Nine locales, conventional Categories-page action and sheet patterns. No feature-state activation in this design phase.

## Review focus

1. Imported/manual clears and category merge racing with apply/undo: Task2 proves protected or atomically refused, never overwritten.
2. Known internal transfers, linked withholding fees and negative income reversals: Task2 includes exclusion controls; category assignment cannot change totals or transfer decisions.
3. Complete dependencies: Task2 proves ancestor/token/type locks and one consistent materialization; cache refreshes remain valid. Duplicate creates and account-rule changes are serialized.
4. Successful apply followed by lost HTTP response or process interruption: Task2 proves commit atomically includes receipt and idempotent replay.
5. Restored data on a new instance: Task3 proves rule/account/category remapping, new format refusal by old reader contract, old backup acceptance and absent historical undo.

## Interface and type contract

New shared DTO file `packages/business/shared/src/dtos/category-rules.ts`; export explicitly from shared index. Existing UUIDs remain strings; times on the wire are ISO strings, with database before-images serialized canonically without Date rounding.

```ts
type CategoryRuleDraft = {
  payeeText: string; accountId: string;
  categoryId: string; enabled: boolean;
};
type SavedCategoryRule = {
  id: string; payeeKey: string; accountId: string;
  categoryId: string; enabled: boolean; revision: number;
};
type RuleScope = { accountId: string; from: string; to: string };
type RulePreviewRow = {
  transactionId: string; occurredAt: string; payee: string;
  amount: string; currency: string;
  beforeCategoryId: string | null; beforeCategoryLabel: string | null;
  afterCategoryId: string; afterCategoryLabel: string;
  ruleId: string; rulePayeeKey: string; provenanceOnly: boolean;
  beforeCategoryColor: string | null; afterCategoryColor: string | null;
};
type RulePreview = {
  previewId: string; expiresAt: string; scope: RuleScope; accountName: string;
  matched: number; protected: number; unchanged: number;
  changed: number; rows: RulePreviewRow[];
};
type RuleApplyResult = { operationId: string; changed: number; replayed: boolean };
type RuleUndoResult = { operationId: string; restored: number; replayed: boolean };
type RuleOperationSummary = {
  operationId: string; status: 'applied' | 'undone';
  changed: number; appliedAt: string; undoneAt: string | null;
};
type RuleRecentOperations = { items: RuleOperationSummary[] }; // at most 20, no cursor
```

Domain methods on `TransactionCategoryRuleService`:

```ts
list(userId: string): Promise<SavedCategoryRule[]>;
save(userId: string, input: CategoryRuleDraft &
  { id?: string; expectedRevision?: number }): Promise<SavedCategoryRule>;
remove(userId: string, id: string, expectedRevision: number): Promise<void>;
preview(userId: string, scope: RuleScope): Promise<RulePreview>;
apply(userId: string, previewId: string): Promise<RuleApplyResult>;
undo(userId: string, operationId: string): Promise<RuleUndoResult>;
recent(userId: string): Promise<RuleRecentOperations>;
```

Typed `CategoryRuleError` with code `NOT_FOUND | INVALID_RULE | DUPLICATE_RULE | RULE_LIMIT | REVISION_CONFLICT | TOO_MANY_ROWS | PREVIEW_LIMIT | STALE_PREVIEW | PREVIEW_EXPIRED | UNDO_CONFLICT | ALREADY_UNDONE | BUSY`. Include safe details only (counts, no payees). Foreign/missing IDs share NOT_FOUND. Target-category deletion has separate `CategoryRuleInUseError(count)` mapped to CONFLICT. Remove requires expectedRevision; missing revisions on edits are invalid. Server generates normalized key; never accepts userId or journal before-images from the client.

Nested protected tRPC routes at `categories.rules.{list,save,remove,preview,apply,undo,recent}`. Preview is a mutation because it stores an operation; apply/undo accept UUID only. Recent uses `(applied_at,id)` descending and limit 20, owner-bound. No cursor input or history pagination. Requests for pruned operation IDs return NOT_FOUND; never reapply. PREVIEW_LIMIT maps to CONFLICT.

## Task 1 — Owner-scoped rule definitions and source compatibility

**Files:**

Create `packages/infra/db/src/schema/transaction-category-rules.ts` and migration `packages/infra/db/src/migrations/20261123150000_transaction_category_rules.sql` (renumber only if upstream already uses that version). Create `packages/business/domain/src/repositories/TransactionCategoryRuleRepository.ts` and `services/categories/TransactionCategoryRuleService.ts`. Modify schema/index.ts, schema/holdings.ts (CategorySetBy), shared category-sources.ts and shared/domain barrels. No wildcard export entries.

Create tests `packages/business/domain/tests/services/categories/TransactionCategoryRuleService.test.ts` and `tests/repositories/transaction-category-rules-schema.test.ts`.

**Consumes:** transaction_payee_key, owned categories/accounts, withTransaction, typedi and existing backup/source types.
**Produces:** list/save/remove; both schemas and the `custom_rule` source, plus the source labels used later. Rule accountId is nonnull. Runs include projectionVersion, candidateIds and changedIds separately; no rule FK on runs.

- [ ] Add failing service/schema cases: `same_payee_same_account_is_unique`, `foreign_account_and_category_are_not_found`, `stale_revision_refuses`, `empty_normalized_key_refuses`, `hundred_and_first_rule_refuses`, `null_account_refused`, `same_payee_different_accounts_are_independent`, `account_delete_cascades_scoped_rule`, `duplicate_create_race_has_one_winner`.
- [ ] Run only those tests under gate-db; confirm failures exercise missing behavior, not missing environment.
- [ ] Implement exact-payee normalization through SQL, composite owner/category FK, account-cascade and per-user lock. Preserve `cleared` null-category exception. Store no freeform expression/code. Rule update affects no ledger rows. Rule delete affects no ledger rows or old operation history.
- [ ] Add schema control tests: custom_rule requires nonnull category; cleared requires null; prior enum values still work. Add existing learned/AI/kind tests that leave custom rows untouched; imported assignment may replace them while preserving person/cleared. No edits to assignment precedence unless a test exposes a mismatch with the defined order.
- [ ] Run touched tests, type-check and lint, then commit this coherent data/domain slice in the assigned worktree. Do not push a separate PR per task; one batch PR.

## Task 2 — Finite preview, atomic apply and conflict-safe undo

**Files:** Extend the Task1 repository/service and tests. Create `packages/business/domain/src/services/categories/custom-rule-eligibility.ts` to reuse TAKES_A_CATEGORY and add the explicit fiat/outflow/fee tests; keep SQL normalization centralized. Add `tests/services/categories/TransactionCategoryRuleService.concurrent.test.ts` for two-connection cases. Repository stores the bounded operation JSON; no per-transaction generic history framework.

**Consumes:** Task1 definitions and DTOs; transaction_payee_key; existing owner/holding/account/token relations.
**Produces:** preview/apply/undo/recent exactly as above; bounded records and exact lock/projection protocol from design revision 2. Repository APIs remain internal to this module; do not expose SQL/fingerprints through tRPC.

- [ ] Add a synthetic fixture with two users, two owner accounts, parent+child categories and rows covering each source and kind. Assert preview writes no ledger rows and makes zero AI/provider calls.
- [ ] Pin `account_rule_never_matches_other_account`, `disabled_rule_does_not_match`, `manual_clear_and_import_protected`, `custom_is_not_learning_evidence`, and `same_category_auto_is_provenance_change`. Assert exact matched/protected/unchanged/changed counts. Rule ordering must not depend on insertion timestamps.
- [ ] Pin negative fiat outgoing/fee positive controls. Exclude deposit, interest, negative reward/dividend reversal, trade, correction, non-fiat, zero, invalid decimal, fee_of, settlement link, swap link, transfer group and review states paired/internal/untracked/split. Null review may pass only as unlinked outflow; no classification assertion or mutation. Positive controls prevent an always-empty matcher from passing.
- [ ] Implement bounded query (LIMIT 501), persisted preview and projectionVersion 1 with named fields from the design table. No full-parent JSON hashing. Produce response, projected values and IDs from one final SQL materialization after dependency locking. At 500 rows preview succeeds; at 501 it refuses without a token or partial list. Time-controlled test: exactly 15 minutes expires; retained applied operation remains idempotent after that deadline. At most 3 unexpired previews: a fourth returns PREVIEW_LIMIT; expired previews are deleted inline before admission. At the 21st application, atomically retain latest 20; an evicted token returns NOT_FOUND with no write. Test cross-account and concurrent cap enforcement. Protect normalized Cyrillic keys and digit-stripped description fallback using SQL, not a second JS normalizer.
- [ ] Implement discovery→lock→final-materialization under READ COMMITTED, using the complete ordered lock table in design.md. Preview compares discovery and final dependency IDs/projections; changed discovery returns BUSY without persisting. Apply compares final IDs/projections to its stored snapshot, not independent ORM reads. Include old categories, target leaves, every displayed ancestor, primary tokens and token types. FOR SHARE blocks non-key updates; transactions use FOR UPDATE. No new dependency may be treated as already locked. Account-rule-set projection includes disabled rules; advisory lock prevents custom-rule phantoms.
- [ ] Implement apply with all candidate IDs for validation, changedIds only for UPDATE. Final predicates include authenticated owner and exact affected-ID/count checks. Store before tuples and after **undo** projection hashes atomically after UPDATE, using the same materializer with the retained prior-category IDs. Include current/prior category leaf identities in those after projections. New transactions stay outside the frozen candidate set; rule edits/deletes/additions stale the preview.
- [ ] Pin `new_rows_not_silently_added`, `manual_edit_between_preview_apply_refuses_all`, `foreign_preview_does_not_leak`, `preview_retry_replays_once`, `concurrent_apply_has_one_commit`, `failure_after_update_before_receipt_rolls_back`, `apply_after_undo_refuses`. Use injected failure at the transaction seam and two actual DB connections, not timer sleeps.
- [ ] Implement undo over **changedIds only**, current/prior category leaves and their smaller dependency projection. No saved-rule load/match/lock, no category ancestors, no protected/no-op candidate locks. Verify retained after hashes and prior-category ownership with SHARE locks held through commit. Restore category/source and fresh updated_at atomically; repeated undo returns its retained result.
- [ ] Test later changed-row pick, clear, import, second custom apply, transfer pairing, deleted changed row/prior category, account move and category merge: each refuses all writes. Verify all noncategory ledger columns stay identical after apply/undo; do not run cache refresh as an effect of category assignment.
- [ ] Execute every concurrency and positive control in the matrix below. Both scheduling directions use two actual DB connections and explicit barriers; no sleeps or pure mocks. A refused assertion, timeout and lost connection are distinct outcomes.
- [ ] Run touched tests and commit. A live DB timeout is unverified, not proof of an assertion failure; follow gate-db's isolation receipt.

### Required concurrency and positive controls

The tests call the public service; a test-only repository transaction barrier pauses at discovery, after dependency locks, or before receipt commit. Record that a waiting writer is actually blocked using a second connection/lock observation, then release it. Every refusal control also has a positive unchanged-input control. Do not count a test timeout as proof of a lock.

| Test | Schedule and exact expected result |
|---|---|
| `holding_revaluation_preserves_preview_and_undo` | Preview; update holding balance/value_quote.calculatedAt/value_base/value_priced_at/cache timestamp; apply succeeds. Refresh again; undo succeeds. No transaction field changes. |
| `unrelated_parent_updates_preserve_operations` | Change account description/metadata/wrapper/updated_at, holding label/hidden state, token provider metadata and type display_order/updated_at. Preview/apply/undo still work. Changing account name stales apply; changing it only after apply does not block undo. |
| `ancestor_rename_before_apply_refuses` | Preview Food→Cafés; second connection renames Food only and commits. Apply returns STALE_PREVIEW with zero category writes. Repeat with ancestor reparent/color change. Child is untouched. |
| `ancestor_rename_after_validation_waits` | Pause apply after dependency locks/final validation. Second connection tries ancestor rename and is demonstrably blocked. Release apply; it commits against the reviewed labels, then rename commits. No mixed preview/receipt. |
| `token_type_change_before_apply_refuses` | Preview fiat row; second connection changes token.type_id to nonfiat, or type.code away from fiat. Apply refuses atomically. Keep unchanged fiat control that applies. |
| `token_type_change_after_validation_waits` | Pause apply after SHARE locks; token.type_id update and, separately, type.code update must wait. Apply commits first; mutation occurs afterward. Transaction token_id differing from holding.token_id is never eligible. |
| `prior_category_delete_before_undo_refuses` | After apply, delete unreferenced previous category. Undo returns UNDO_CONFLICT; all changed rows retain custom category. Keep existing-prior-category successful control. |
| `prior_category_delete_after_validation_waits` | Pause undo after prior-leaf SHARE lock/validation. Deletion blocks; undo restores first. Deletion afterward follows existing category semantics. No raw FK error or stale validation. |
| `rule_delete_does_not_block_undo` | Apply; delete its saved rule; undo succeeds from retained operation. Repeat with disabled/edited rule. Assert undo makes no saved-rule SELECT/lock. |
| `protected_and_noop_edits_do_not_block_undo` | Preview contains changed, imported-protected and custom-no-op rows. Apply; edit/delete the latter two. Undo restores only changed IDs. Hold a lock on a no-op row during undo: undo must still finish, proving it never locks that row. |
| `changed_row_edit_refuses_all_undo` | Apply to two changed IDs; pick/clear/link one afterward. Undo refuses both. Current/prior leaf label changes alone do not prevent undo; ownership loss does. |
| `discovery_dependency_change_refuses_cleanly` | Pause preview after discovery; commit ancestor reparent/token.type_id/holding.account_id change. Final dependency ID set differs: BUSY, no preview persisted, no ledger writes. Parent cache-only change instead yields a valid, internally consistent preview. |
| `preview_response_matches_persisted_materialization` | Assert returned IDs/counts/labels equal the retained snapshot, and returned row values come from the same final projection whose hash is stored; do not persist raw transaction images. Race label changes around discovery/locking. Result is coherent or typed refusal, never a mix. |
| `existing_writer_races_are_atomic` | Manual pick/category delete competes with apply and undo in both lock orders. Observe valid serialization, documented stale/conflict, or BUSY after rollback; never partial updates or an untyped DB error. |
| `operation_caps_and_replay_window` | Concurrent previews stop at 3; expired slots can be reused. Applied receipt survives15-minute deadline. Apply 21 prunes only oldest application; undoing recent entries does not reorder retention. Pruned UUIDs cannot apply/undo again. |

## Task 3 — Category deletion, erasure and portable backups

**Files:** Modify `TransactionCategoryService.ts`, `TransactionCategoryRepository.ts`, `use-cases/user-data-deletion-manifest.ts`, `services/backup/backup-plan.ts`, and existing backup tests. Keep BackupRestorer.ts/id-rewrite.ts unchanged unless a round-trip test demonstrates a concrete failure; do not generalize remapping. Extend category and backup tests in existing mirrored tests directories. Add `tests/services/backup/category-rules.test.ts`; update backup version assertions/fixtures for 3 while retaining explicit v1/v2 controls.

**Consumes:** saved rules and operation history; existing account/category ownership and deletion/backup machinery.
**Produces:** safe category operations, rule round-trip and user erasure; backup version 3.

- [ ] Assert rule-referenced category deletion/merge (even disabled rule) returns CategoryRuleInUseError and changes no categories or ledger rows. Race delete versus save/apply must yield one valid committed state or typed conflict, never a dangling category/wrong-owner relation.
- [ ] Keep category rename/reparent/recolor behavior; previews containing their changed labels become stale. Rule target stays the same category UUID. Advance updated_at in moveTransactions; a category move away and back must still invalidate an older undo receipt. Test that sequence as a regression control. Reuse existing FKs as final race protection; translate constraint failures to the same typed errors.
- [ ] Include saved rules after account/category records in BACKED_UP_TABLES; explicitly exclude runs with INSTANCE_HISTORY. Increment BACKUP_VERSION to 3. Existing allocate-IDs-first plus recursive UUID rewrite remaps rule account/category IDs and owner to destination; custom ledger source survives. Older version fixtures still load; format 3 rejects under a version 2 reader check. No operation history is falsely offered as undoable on the new instance. Include a backup with custom_rule ledger rows but zero saved rules; format 3 and preserved provenance still round-trip.
- [ ] Register both new tables in user erasure manifest before categories/accounts; the new category FK is RESTRICT. Financial-account deletion cascades scoped rules; existing history remains private and undo refuses missing rows. Assert deletion leaves no rule/run rows; foreign user's data survives. Backup contents contain no full-row undo snapshots or shared-household rule state.
- [ ] Run focused compatibility tests and commit. Inline bounded cleanup is covered in Task2; no scheduled purge or retention framework.

## Task 4 — Protected tRPC and one usable Categories-page flow

**Files:** Create API `presentation/routers/category-rules.ts`; mount it under existing `routers/categories.ts`. Extend `categories.ts` error translation for CategoryRuleInUseError. Create API `tests/presentation/routers/category-rules.test.ts` using makeAuthedCaller and isolated fixtures as in accounts-wrapper.test.ts; reconfirm these conventions in the OSS worktree.

Frontend: extend `v3/pages/CategoriesPage.tsx`; create `v3/components/categories/CategoryRulesSection.tsx`, `CategoryRuleFormSheet.tsx`, `CategoryRulePreviewSheet.tsx`. Modify CategoryDeleteSheet, AutoCategoryNote, account-export source labels and all nine locale JSON files (`ar,en,es,fr,id,ja,pt,ru,zh`). Extend AUTO_CATEGORY_SOURCES consumers only for custom provenance. No new route/nav/shell splitting.

Create frontend mirrored tests for CategoryRulesSection and CategoryRulePreviewSheet; extend AutoCategoryNote/CategoryDeleteSheet/ledgerConfig tests.

**Consumes:** Task1–3 DTOs/interface; existing account/category pickers, FormSheet, page action and toast/invalidation conventions.
**Produces:** end-to-end saved-rule create/edit/disable/delete and review/apply/recent-applications/undo flow in Categories.

- [ ] Pin cross-tenant IDs, household view-only account, malformed dates, missing revision, oversized payee and request-supplied before-images refusal at router input. Confirm demo mode refuses mutations through the existing middleware.
- [ ] Map NOT_FOUND→NOT_FOUND; revision/duplicate/stale/undo conflict/in-use/busy/already-undone→CONFLICT; validation/limit/expired→BAD_REQUEST. Include a reason code for UI, no raw SQL/payee text in errors. No route logs raw inputs.
- [ ] Implement UI with the saved canonical key visible before preview/application, finite account/period picker, full changed-row list, protected/no-op counts, and category/amount labels. Apply is disabled during in-flight requests and when preview expired/empty; stale preview has a clear Refresh preview action. No hidden partial apply. On success invalidate categories and transactions.
- [ ] Add bounded recent applications (last 20 total, including undone) with Undo; no cursor or load-more UI. Explain retention and the three-preview cap/expiry. Empty/expired/pruned operations show a readable outcome. Rule deletion copy says existing categories remain. Category delete conflict links to the Saved rules section. No auto retry after mutation errors. Lost-response retry sends the same previewId.
- [ ] Assert keyboard/focus behavior, loading/error states, expired/stale preview and mixed currencies without a misleading total. Test all locale keys exist, including custom provenance in exported rows. Compare 390×844 layout with Categories/Transactions sibling patterns.
- [ ] Run touched tests and type-check/lint; commit with the prior tasks on one batch branch.

## Task 5 — OSS verification and operator handoff

**Files:** Add shared user docs `apps/frontend/docs/src/content/docs/features/category-rules.md`; adopt this design/plan into `docs/superpowers/specs/2026-11-23-category-rules-design.md` and `docs/superpowers/plans/2026-11-23-category-rules.md` in the assigned worktree. Add one synthetic E2E journey `apps/e2e/tests/transactions/category-rules.spec.ts`, using existing authenticated fixture conventions (do not use production accounts).

- [ ] E2E: create rules for the same payee in two accounts, prove independent targets, preview one account’s mixed fixture, apply, verify only reviewed eligible rows changed, undo; second run edits one row then proves whole undo refuses. Verify persisted rule after reload and successful undo after deleting that rule. Verify protected/no-op edits cannot block undo on changed IDs. Capture desktop and 390×844 screenshots with sibling layout comparison.
- [ ] Run locally only touched tests against an owned isolated Postgres, never the entire suite. Set DATABASE_URL to that instance first. Keep the normal preloads and final test counts; the public base has no gate-db wrapper.

```sh
NODE_ENV=test bun test \
  --preload ./packages/business/domain/test-preload.ts \
  --preload ./apps/frontend/app/tests/i18n-preload.ts --timeout 30000 \
  packages/business/domain/tests/services/categories/TransactionCategoryRuleService.test.ts \
  packages/business/domain/tests/services/categories/TransactionCategoryRuleService.concurrent.test.ts \
  packages/business/domain/tests/repositories/transaction-category-rules-schema.test.ts \
  packages/business/domain/tests/services/backup/category-rules.test.ts \
  apps/backend/api/tests/presentation/routers/category-rules.test.ts \
  apps/frontend/app/tests/v3/components/categories/CategoryRulePreviewSheet.test.tsx
```

Also run the touched existing category/AI/import/backup/deletion tests, named in the implementation receipt; keep the selection explicit. Use OSS package.json's existing E2E command with `tests/transactions/category-rules.spec.ts` as the filter; inspect its invocation before running, rather than inventing a runner. Container setup follows the docker skill if required.

- [ ] Run `bun run type-check`, `bun lint:fix`, `bun run deps:unused`, `bun run docs:check` and OSS-required static checks. No dependency addition, so no new dependency install/upgrade beyond ordinary worktree setup. Review git diff for private overlay/credential data and unintended formatting before push.
- [ ] One OSS batch PR; green exact-commit CI plus exercised E2E evidence before merge under applicable repo rules. Parent coordinates private upstream sync and production acceptance; this plan does not authorize using the shared checkout or direct production writes.
- [ ] Handoff names exact changed scope, tests/CI results, replay/undo demonstration, new format 3 compatibility, and remaining SC-1652 tags/splits/continuous rules. Mark only this slice delivered, not the umbrella task complete without parent reconciliation.

## Dependencies and self-review

Required now: parent plan review, isolated OSS worktree, its dependencies and isolated test database. No vendor account, credential, new worker, SC-1623 completion or private feature flag is needed. Category-spending reports can follow the existing categories independently; they must not wait for tags or a continuous rules engine.

Self-review performed without a new worker, as instructed. Coverage: all spec sections map to Tasks1–5. Definitions/normalization/precedence→1/2; preview/atomicity/undo→2; deletion/backup→3; privacy/UX→4; release exercise→5. Key risks explicitly pinned: accidental learning cascade, custom/learned source confusion, post-preview rule insertion, volatile parent caches, complete ancestor/token/type locks, changed-only undo after rule deletion, bounded persistence, transfer/income leakage, category deletion and old backup readers. Review P2s map to the normative projection/locking tables and the concurrency matrix above. No code or tests executed during plan preparation.
