# SC-1652 — saved category rules, first slice

Status: accepted revision 2, 2026-11-23. Implemented against OSS base 4a894bcf4b48629f9ac5cf2b230948c5b6f34ae5.

## Outcome and approaches

A person can say “For this payee, use this category”, inspect exactly which existing outgoing transactions would change, apply once, and undo that application without reverting financial evidence or later edits.

Three approaches considered:

1. **Saved rules with explicit preview/apply/undo — chosen.** Useful beyond existing majority learning: an exact payee rule works before there are any categorized examples and works within one explicitly selected account. Finite, reviewable writes; no import hooks.
2. Add continuously running custom rules to import/AI/pick pipelines. More automation, but requires durable per-row rule ownership, disabling/retraction semantics and recovery after worker interruption. This is a separate later slice.
3. Turn the existing learned-category query into a generic condition/action engine. Reuses a name, but changes a working inference mechanism and couples explicit rules to learning. Rejected.

**Size:** approximately 4–6 engineering days including DB race tests, UI exercise and OSS/private integration. Two tables, one domain module and one Categories-page section. No new library, worker, scheduler, framework, DSL, regex, third-party service or paid dependency. No global rules, history pagination, tags, splits, budget reports, amount predicates, arbitrary text contains, multi-action rules, income rules or automatic new-row application in this slice. These remain on SC-1652/1653 as applicable. This slice does not complete the whole SC-1652 umbrella.

## Current code and why the seam is here

Revision2 also has schema/field receipts. See source receipts for exact paths, line numbers and hashes. The corrected audit establishes that categories, bulk assignment and learned/AI categorization are already shipped. No competitor feature claim is needed to justify this residual slice.

- `LearnedCategoryRules.ts`: two-thirds payee majority from `person`/`import` evidence; only null/`rule`/`ai`/`kind` targets. `afterImport()` runs kind assignment then learning. Existing `rule` means **learned**, not custom.
- `ImportedCategoryAssigner.ts`: preserves `person` and `cleared`; may replace all other sources. Preserve this hierarchy.
- `KindCategoryAssigner.ts`: only null/null targets; AI also writes only open rows. Neither needs a custom-rule call.
- `HoldingTransactionRepository.setCategory()` marks picks `person`, clears `cleared`; router then spreads learned evidence. Calling this path for custom rules would trigger unpreviewed writes, so do not call it.
- `transactions.ts:67`: category assignment already handles 500 ids. Do not rebuild bulk assignment.
- `outside-categories-sql.ts` / shared `category-sources.ts`: reusable structural exclusions for trades, transfer legs, opening and correction rows.
- `transaction_payee_key(counterparty,description)` is the sole normalized-payee definition, including Unicode behavior. Do not duplicate normalization in JavaScript.
- API `AgentWriteJournal` snapshots many complete user tables, records after writes outside their transaction and restores full rows. It is not a suitable category-only transactional undo module; do not import the API into domain or refactor the whole journal here.

The new deep module is `TransactionCategoryRuleService`: callers provide an owner and a bounded request, and receive a preview, one application or one undo. Matching, tenancy, deterministic precedence, stale-state refusal and transactional recording live behind this interface. The repository owns SQL and row locking; no interchangeable repository interface or factory is needed.

## Rule definition and deterministic precedence

A rule has `id`, `userId`, `payeeKey`, required nonnull `accountId`, `categoryId`, `enabled`, integer `revision`, and timestamps. It performs exactly one action: assign an existing category owned by that user. Root and child categories both work; IDs, not display names, identify them.

Creation/edit input: `payeeText` (trimmed 3–200 Unicode code points), required owned account ID, category ID, enabled boolean. The server uses `transaction_payee_key(payeeText, NULL)` and refuses a null result. Save returns the resulting key; the saved-rule row displays it before any application. The editor explains normalization without duplicating it or adding a normalization endpoint. Payee matching is exact equality to `transaction_payee_key(row.counterparty,row.description)`; the fallback description can collapse digit runs by existing convention. UI explains this with the normalized key; no hidden substring matching.

At most 100 saved rules per user. Unique `(user_id,account_id,payee_key)` prevents duplicates, including disabled rules. A transaction can match only its account's single enabled rule for that exact key. Disabled means no custom match. There are no global rules, overrides, priorities, or insertion-time tie breakers. Null account IDs are refused in the DTO and schema. Identical payees in different accounts may have different categories.

Category authority:

1. `person`, `cleared`: untouched, including explicit “none”.
2. `import`: untouched.
3. `custom_rule`: this slice's new source; may be replaced only by an explicitly previewed application, by a person, or by a later import.
4. `rule` (learned), `ai`, `kind`, null: may be replaced by the matching enabled account rule.

This is a partial authority order, not an instruction to change precedence among existing learned/kind/AI writers. Custom writes never become `person` or `import` learning evidence. `AUTO_CATEGORY_SOURCES` includes `custom_rule` for filtering and Keep; Keep is an explicit person action and can teach learning as today. The UI labels it “Set by your saved rule” rather than reusing the learned-rule explanation. Existing learned, kind and AI writers already exclude custom rows by their positive source predicates; pin this with tests.

## Eligible rows: outgoing fiat only

Every preview/apply request names **one owned account** and a finite UTC interval `[from,to)` with `from < to`. UI starts at the selected month, using existing date-boundary helpers. No arbitrary userId or household owner override comes from the browser.

A candidate must satisfy all of:

- Holding and transaction belong to the authenticated owner and the selected owned account.
- Token type is positively `fiat`; signed numeric quantity is strictly negative. Zero, positive amounts, malformed numbers and non-fiat rows are excluded, not coerced through Number.
- Legacy kind is `withdraw` with engine `ledger_kind='outflow'`, or legacy `fee` with engine `ledger_kind='fee'`. Null, unknown and inconsistent classification is excluded.
- `TAKES_A_CATEGORY`, plus no swap/settlement/fee-of linkage. Exclude transfer-review answers `paired`, `internal`, `untracked`, `split`; only null, `left_control` or `fee` are admissible. A null review is still an unlinked outflow, not proof of spending.
- One enabled custom rule matches the normalized payee and scope.

Income, dividend, interest, reward, deposit, trade, transfer, opening, correction and withholding-linked fee rows never enter this slice. No user switch overrides these exclusions. Existing manual categorization continues to support its current wider scope.

Assigning a category is **not** a transfer/spending classification decision. Unresolved outflows remain unresolved; `kind`, `ledger_kind`, transfer review, links, quantities, prices, balances, returns and tax fields cannot change. Future SC-1653 reporting must retain its own flow exclusions, not infer spending from category presence.

## Preview, application and undo

Preview reads at most **501 matching, structurally eligible rows**, before filtering category authority/no-ops. A 501st row yields `TOO_MANY_ROWS`, with no token or partial list. For <=500, return matched/protected/unchanged/changed counts and every changed row. Display native amount, token symbol, payee, date, old/new category paths and matching normalized rule. No currency conversion or mixed-currency total. New transactions arriving after candidate discovery are excluded; copy says “Only these reviewed transactions will change.”

Preview creates a private operation record and never changes the ledger or calls AI. Freeze `candidateIds` and an explicit `changedIds` subset, scope, rule-set projection, category paths, and fingerprints. Preview expires after **15 minutes**; apply accepts only its opaque owner-scoped UUID. A stale input refuses the entire apply. No automatic re-plan or partial writes. Same-category automatic sources becoming custom count as visible provenance changes; same-category custom rows are no-ops. Person/cleared/import remain protected.

One transaction writes only `category_id`, `category_set_by='custom_rule'`, and `updated_at` for changed IDs, plus the operation's before/after tuples and after-fingerprints. Retain owner predicates on final UPDATE/RETURNING and verify exact affected IDs/count. Do not call setCategory/spreadFrom, refresh valuations or change financial/classification fields. The receipt commits with the writes. Lost-response retries return the retained applied result. Apply after undo returns ALREADY_UNDONE. Expiry affects only unapplied previews.

**Undo uses only the immutable operation and `changedIds`.** It does not load, require, lock, or re-evaluate saved rules. Rule deletion/disable/edit cannot invalidate undo. It never locks or hashes protected/no-op candidates. Each changed row must match its after-conflict projection, and its previous nonnull category must still belong to this owner. Missing/changed dependencies produce UNDO_CONFLICT with zero writes. Restore only previous category/source and a fresh updated_at. Repeated undo returns the retained result. Existing automatic categorization may resume after restoration; custom rules never run unattended.

### Exact projections and materialization

Use one versioned projection (`projectionVersion: 1`) rendered as named `jsonb_build_object` fields in PostgreSQL, not full related records. Hash canonical JSONB text using Bun.CryptoHasher SHA-256. JSON arrays sort by UUID, except category paths ordered root→leaf. Distinguish null from absent. Serialize timestamps in PostgreSQL as UTC text with all six fractional digits, never JavaScript Date equality. Inputs and response fields come from this same materialized result. Preserve raw numeric strings; validate signs with existing Decimal handling, not Number or an unchecked SQL numeric cast.

The **transaction projection T** contains these exact SQL columns:

```
id, user_id, holding_id, token_id, kind, quantity,
price_native, price_native_token_id, counter_token_id, counter_quantity,
counter_price_native, counter_price_native_token_id, fee_quantity, fee_token_id,
occurred_at, external_id, swap_group_id, transfer_group_id, settles_transaction_id,
transfer_review, transfer_reviewed_at, transfer_review_source,
transfer_review_rule_id, transfer_review_split, source, source_metadata, raw_payload,
counterparty, description, ledger_kind, kind_subtype, group_id, fee_of, input_id,
execution_price, execution_price_token_id, kind_origin, decision_id,
category_id, category_set_by, created_at, updated_at
```

This intentionally retains strict transaction-edit conflicts, including its own updated_at; these are ledger records, not holding price caches. Only their hash and category tuples persist, not full raw payloads. Add no future column implicitly; projection changes require a version decision. Comparison does not dereference informational token/input/decision IDs: their IDs are transaction evidence, but their records do not affect this slice.

| Dependency | Preview/apply projection | Undo conflict projection |
|---|---|---|
| Each candidate transaction | T; normalized payee derived by SQL | T, **changed IDs only**, compared to the committed after image |
| Holding for each relevant transaction | id,user_id,account_id,token_id | Same, changed IDs' holdings only |
| Selected account | id,user_id,name | id,user_id; account rename is irrelevant to undo |
| Primary token | id,type_id,symbol | id,type_id; token symbol rename is irrelevant to undo |
| Primary token type | id,code | id,code; must remain fiat |
| Old and target category leaves, plus every ancestor shown in either path | id,user_id,parent_id,name,color for every distinct node | Only current and prior category leaves: id,user_id; no labels, parents or ancestors |
| All saved rules scoped to selected account, including disabled | id,user_id,account_id,payee_key,category_id,enabled,revision | **None** |
| Operation | owner,scope,projectionVersion,candidateIds,changedIds,definition/display snapshot,before tuples/hashes,status,expiry | owner,projectionVersion,changedIds,before tuples,after hashes,status; no candidate-only dependencies |

Require `transaction.token_id = holding.token_id`, not merely two independently valid token IDs. Derive the already-held primary token by FK and use its type code; this slice adds no catalog visibility lookup. No institution, account-type or token-name label is displayed in the preview; those records are not dependencies. Category paths include all ancestor IDs and values. Detect cycles or missing ancestors and refuse the materialization; never silently truncate a displayed path. Null old category has no ancestor dependency.

Explicitly excluded parent fields: holding balance, label, hidden/active settings, all value_base/value_quote/value_priced_at/calculatedAt/cache/scheduling fields and parent updated_at; account description, institution/type/entity/wrapper/metadata/hidden/active/settings/timestamps; token name, price/provider metadata, precision/settings/timestamps; type name/order/settings/timestamps; category display_order/timestamps. Updating those fields can briefly contend on a row lock but cannot create a fingerprint mismatch. Holding/account/type cache refreshes must preserve preview and undo validity. Transaction edits retain the strict policy above.

### Complete lock order and consistent read protocol

Use PostgreSQL READ COMMITTED with explicit dependency locking and final single-statement materialization. Never combine independently timed ORM reads into a snapshot. Every mutation takes transaction-scoped `pg_advisory_xact_lock(hashtextextended('category-rules:' || userId,0))` first. This serializes custom definitions, preview capacity/history pruning and operations for that owner. It is not a lock on existing category/token/ledger writers. A hash collision only serializes unrelated owners.

After the advisory lock, acquire required rows in this exact table order, with UUID ascending within each table:

| Order | Rows | Mode |
|---|---|---|
| 1 | Authenticated users row (FK/erasure coordination) | FOR KEY SHARE |
| 2 | Relevant existing operation rows, including those being pruned | FOR UPDATE |
| 3 | Account-scoped rule definitions for preview/apply; edited/deleted rule for save/remove; **none for undo** | FOR UPDATE for definition mutation; otherwise FOR SHARE |
| 4 | Selected owned account | FOR SHARE |
| 5 | All old/new category leaves and displayed ancestors for preview/apply; only current/prior changed-row leaves for undo; target leaf on save | FOR SHARE |
| 6 | Relevant holdings | FOR SHARE |
| 7 | Primary tokens | FOR SHARE |
| 8 | Referenced primary token_types | FOR SHARE |
| 9 | Candidate transactions for preview/apply; changed transactions only for undo | FOR UPDATE |

FOR SHARE is intentional: FOR KEY SHARE would allow a non-key label/type/ownership update during validation. No lock upgrade is needed for candidate transactions. Save/remove do not touch ledger rows; take only applicable rows from this order. Global catalogs may briefly contend; 500 candidates bound ledger locks. Existing writers may take different orders; deadlocks are refusals, never permission to omit dependencies.

**Preview protocol:** after locking the account's rule set and account, one discovery statement returns up to 501 candidates, projection values, normalized keys, complete category ancestor chains, dependency IDs and proposed changes from one statement snapshot. Overflow refuses before persisting. Acquire its dependency rows in the order above. Then one final statement re-materializes **those exact IDs**, complete chains and rule projections. Compare both dependency ID sets and projected values with discovery. If either differs, or any required row is absent, return BUSY (“Data changed; preview again”) with no operation or ledger write. Do not expand the lock set or retry internally. A newly inserted transaction is deliberately outside the frozen candidate set.

**Apply protocol:** lock operation, its current account rule set and stored dependency IDs in order. One final statement materializes all candidate projections, complete current ancestor chains, eligibility, authority, rule matches and display values. Require exact dependency sets and equality with the stored preview, plus unexpired status. New account rules are detected by comparing the complete scoped rule projection; the advisory lock prevents custom-rule phantoms during validation. Any renamed/reparented ancestor or token type pointer changing before locks yields STALE_PREVIEW. A newly discovered ancestor/token/type is not read as if locked: its presence changes the ID set and refuses the transaction. No writes precede validation. All acquired rows remain locked through category updates and receipt commit.

**Undo protocol:** lock operation and discover only changed rows' current parent IDs and current/prior category leaf IDs. Lock that finite set in the same order (skip rules and ancestors). One final statement verifies the dependency ID sets, narrower undo projections, after hashes, owner/account/token consistency, fiat type, and each prior category's ownership. Compare to the stored after-conflict projection. Missing prior categories or changed transaction inputs yield UNDO_CONFLICT. Do not compare current rule definitions, displayed labels, protected/no-op rows or unrelated parent fields. Locks on prior category leaves prevent their deletion after validation. Category rename/reparent/recolor may preserve undo because only IDs/ownership are restored.

A token type change after the validation barrier must wait on the token/type SHARE lock until commit. The same applies to ancestor renames during apply, category deletion during undo, or manual/transfer writes to transaction rows. Changes committed **before** the locks trigger the documented mismatch/refusal. Changes committed afterward are later operations, never overwritten by this operation.

Timeout/deadlock/serialization SQLSTATEs 55P03/57014/40P01/40001 map to BUSY after rollback. Missing/mismatched apply dependencies map to STALE_PREVIEW; undo dependencies map to UNDO_CONFLICT; rule-save duplicate/in-use constraints map to their typed errors. Never expose raw SQL errors or silently replay a mutation. Keep the 3-second lock/statement timeout. Positive race tests release barriers before timeout; contention tests separately prove BUSY with zero partial writes.

### Bounded recent operations

At most **3 unapplied previews** per owner. Before creating a preview, delete that owner's expired preview records inside the advisory-locked transaction. If three unexpired records remain, PREVIEW_LIMIT refuses creation; copy explains that the user can apply an existing preview or wait until its displayed expiry (at most 15 minutes). No silent eviction of an active preview. The cap is cross-account and concurrent creates cannot exceed it. Refresh creates another preview under the same cap; there is no unbounded refresh log.

Retain only the **20 most recently applied operations**, counting applied and undone together, ordered `(applied_at,id)` descending. Applying the 21st prunes the oldest complete operation atomically with the new apply. UI states “Undo is available for your last 20 applications.” No cursor, pagination or separate history page. The retained receipt is the idempotency/undo window; an evicted UUID returns NOT_FOUND and can never apply again. Retained applied receipts do not expire at 15 minutes. At most 23 operation records per owner persist, each with <=500 candidates. User erasure removes all. No scheduler, retention framework or third table.

## Storage, compatibility and lifecycle

Two tables in `schema/transaction-category-rules.ts`:

- `transaction_category_rules`: columns above; user FK cascade; `(category_id,user_id)` composite FK to categories **RESTRICT** deletion; required nonnull account FK cascade deletion; never SET NULL. Service validates account ownership and locks it on save. `revision` increments on every definition/state update; optimistic expectedRevision prevents lost edits.
- `transaction_category_rule_runs`: UUID, user FK cascade, status preview/applied/undone, scope JSON, immutable rules/categories snapshot JSON, <=500 candidate records JSON, created/expires/applied/undone timestamps, saved result. Persist candidateIds separately from changedIds. Each candidate stores transactionId, rule ID, before category/source/apply hash and expected category/source; after undo-conflict hash exists only for changed IDs after apply. A projectionVersion column pins serialization. This is a bounded operation log, not a general audit framework. No FK from an operation to a rule or transaction: rule/transaction deletion must not erase retained operation history; the explicit last 20 retention rule still applies.

No ledger rule-ID column is needed: operation history carries provenance. Extend the category source union/check with `custom_rule`. Preserve the existing `cleared` null-category exception and null-following trigger.

Category rename/reparent/recolor retains rule target by ID but invalidates previews. Category delete/merge that a saved rule still references returns typed conflict: “Update or delete the saved rules using this category first.” Disabled rules count too. Add an owned rule count/link to the deletion sheet. Never silently delete or retarget a rule as a side effect of category deletion. Category move/merge must also advance each affected transaction’s updated_at, closing the existing moveTransactions timestamp omission. Once references are gone, the existing category-delete behavior remains; old operation undo may then correctly refuse.

Backups include saved rules after accounts/categories; exclude run history as instance-specific history with an explicit backup-plan reason. Keep custom provenance on restored ledger rows, though no historical undo is offered on the destination. Introduce backup format **3** so old readers fail clearly; new readers still accept v1/v2 with no rules. Use existing allocate-IDs-first and recursive id-rewrite.ts UUID remapping. Prove account/category/user remapping with round-trip tests; do not generalize FK remapping. Format 3 also applies when custom_rule rows remain but zero saved rules remain. User erasure removes both tables through the deletion manifest, ordered before categories/accounts; user deletion also cascades. Financial-account deletion cascades its scoped rules. Operation history remains owner-private, and undo refuses when its account or rows are gone. Rule deletion leaves applied ledger categories unchanged; undo stays in operation history. Inline expiry cleanup and last 20 application retention follow the bounded policy above; no background purge task.

## Privacy, API and UX

Ownership checks apply to every list/save/remove/preview/apply/recent/undo. Foreign and missing IDs both yield NOT_FOUND. Household shared accounts are view-only and cannot be used as owner scopes. No rule text, payee, description, amount, category label or candidate list in request logs, analytics, exception messages or third-party prompts; operational logs contain only operation IDs/status/counts. Server-rendered strings are escaped normally. Database backup/export remains private to the owner. Demo mode uses the existing write refusal.

Add a “Saved rules” section to Categories, with the normal page-level creation action (not a list-toolbar create button). Reuse FormSheet, CategoryPicker, account picker, row patterns and all nine locales. The editor shows entered payee, required account and target category; the saved row shows the canonical key; preview is a separate explicit action.

```
Saved rules                     [Add rule]
Payee: cafe example  ·  Everyday account → Food › Cafés
[Edit] [Disable] [Delete]

Apply saved rules
Account: Everyday  |  Period: November
[Preview]
8 changes · 2 existing choices protected · 1 already correct
Payee / date / amount / old category → new category / matching rule
Only these reviewed transactions will change.
[Apply 8 changes]

Applied 8 changes                           [Undo]
```

For stale preview/undo conflict: readable message, no success toast, reload action. Screen-reader headings, focus return, keyboard actions, loading/errors and 390×844 layout match existing Categories/Transactions patterns. One screen, no new nav destination or import wizard. Recent applications lists the retained last 20 applied/undone operations, with Undo and explicit retention copy. There is no pagination.

## Release and dependencies

Parent assigns OSS worktree after plan review. Re-read OSS AGENTS and confirm the source seams there; private source inspection is evidence, not permission to copy its overlay. Feature belongs in shared domain/db/API/frontend/docs. No private billing/flag/analytics dependency, secrets or vendor prerequisite. Schema migration precedes code; CHECK expansion is backward-compatible to older readers, but rollback to old code must hide new rule UI and retain schema/data until a forward fix. Do not pretend dropping tables/restricting source values is safe rollback.

OSS PR and tests first, then parent coordinates private upstream sync and eventual release. No implementation, new workers, commits or workspace edits were performed in this design phase.
