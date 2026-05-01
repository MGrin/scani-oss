# docs/

This folder is **intentionally empty.**

The previous contents (155 files across `archive/`, `backend-fixes/`,
`features/`, `implementation/`, `performance/`, `stability/`, `technical/`,
plus root-level `ARCHITECTURE.md` / `IMPLEMENTATION_PLAN.md` / `SELF_HOST.md`
/ `PUBLISHING.md`) had drifted far enough from the current codebase that
deleting the lot was cheaper than auditing each page. The repo's source of
truth is the code itself. `CLAUDE.md` covers conventions and the high-level
map. This folder will be repopulated on demand, file by file, with docs that
actually match what's shipped.

## When asked to "check / verify / write / update documentation"

Do **not** start writing immediately. The expected workflow is:

1. **Read the codebase first.** For the area you're documenting:
   - Trace the call graph. Read every file in the relevant package(s) /
     app(s), not just the headline service.
   - Read the schema (`packages/infra/db/src/schema.ts`) and any relevant
     migrations under `packages/infra/db/src/migrations/`.
   - Read the tests — they encode the contract.
   - Read related queue jobs (`packages/infra/queue/src/queue-names.ts`,
     `apps/backend/worker/src/processors/`).
   - Skim recent `git log` for the area to catch in-flight changes.
2. **Build a mental model.** What are the entrypoints, the state
   transitions, the failure modes, the external dependencies, the
   invariants? If you can't answer those, you're not ready to write.
3. **Then write.** Use the structure below. One document per topic.
   Lead with the problem the system solves, not the implementation.
   Be specific — cite real file paths and function names. Write so a
   future Claude session (or human) can pick the system up cold.
4. **Verify.** Re-read what you wrote against the actual code. Every
   path, function name, and behavior claim must be checkable. If it's
   not in the code today, don't put it in the doc.

## Required structure

Anything you create in this folder must fit one of these slots. Don't
invent new top-level subdirectories without good reason.

```
docs/
├── README.md                    ← this file
├── ARCHITECTURE.md              ← single-page high-level system map
├── SELF_HOST.md                 ← self-hosting guide (Tier 1 / OSS)
├── PUBLISHING.md                ← release / publishing notes
├── features/                    ← per-feature deep-dives
│   └── YYYY-MM-DD_<feature>.md
├── technical/                   ← subsystem deep-dives (queue, DI, auth, …)
│   └── YYYY-MM-DD_<subsystem>.md
├── implementation/              ← active implementation plans
│   └── YYYY-MM-DD_<plan>.md
└── archive/                     ← historical docs kept for context
    └── YYYY-MM-DD_<original>.md
```

## Rules

- **Naming**: time-sensitive docs (anything other than the four root
  files) use the `YYYY-MM-DD_<slug>.md` prefix. The date is the day the
  doc was first written, not the date of the underlying change.
- **No `.md` outside `docs/`**: the only allowed markdown files outside
  this folder are `README.md`, `CONTRIBUTING.md`, and `CLAUDE.md` at the
  repo root. Never put `.md` under `apps/*` or `packages/*/src/`.
- **Promote before duplicating**: if a doc references something that
  belongs in `CLAUDE.md` (a convention, a hard rule, a gotcha that
  affects all future work), put it in `CLAUDE.md` and link from here.
- **Archive, don't rewrite history**: when a doc becomes stale, move it
  to `archive/` rather than editing it into incoherence. The next
  version goes in the appropriate live subfolder with a fresh date.
- **Delete dead docs**: archive is for *historically interesting*
  context. Implementation notes for a feature that shipped months ago
  and no longer matters should be deleted, not archived.
