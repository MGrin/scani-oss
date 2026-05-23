---
title: Engineering conventions
description: The non-negotiable rules of this repo. Code that violates them should be fixed in place or rejected at review.
sidebar:
  order: 2
---

These come from
[`CLAUDE.md`](https://github.com/MGrin/scani-oss/blob/main/CLAUDE.md)
— that file is the canonical spec for both human and agent
contributors. Read it. The condensed list below covers what most
PRs trip over.

## Runtime + toolchain

- **Bun only.** No `npm` / `pnpm` / `yarn`. Use `bun install`,
  `bun run`, `bun test`, `bun build`. Reach for Bun primitives
  (`Bun.file`, `Bun.serve`, `Bun.$`) over Node equivalents when
  one fits.
- **Type-check with `tsgo`**
  (`@typescript/native-preview`). Every workspace's `type-check`
  script must call `tsgo --noEmit`. Don't regress to plain `tsc`.
- **Lint with Biome.** One `biome.json` at root. No ESLint, no
  Prettier, no parallel formatter. `bun lint:fix` is the only
  formatting/linting command.

## Imports

- **Top-level imports only.** No `await import(...)`, no
  `require()`. If a module needs lazy initialisation, restructure
  boot order so dependencies are statically resolvable.
- Existing `await import` calls in
  `apps/backend/{api,worker,data-provider}/src/index.ts` predate
  this rule. Refactor them when you touch those files.

## OOP + DI

- **Domain logic lives in `@Service()`-decorated classes.** SOLID,
  one responsibility per class, compose over inherit.
- **Class-field DI**, not constructor-param injection. See
  [Dependency injection pattern](/contributing/di-pattern/) for
  why — it's a Bun-specific runtime requirement, not a style
  choice.
- **DRY across packages.** Two places reaching for the same logic →
  promote into a `packages/*`. No copy-paste between apps.

## Tests

- **Tests live in `tests/` next to `src/`**, mirroring the source
  tree. E.g.
  `packages/business/domain/tests/services/HoldingService.test.ts`
  for
  `packages/business/domain/src/services/HoldingService.ts`.
- Existing inline `*.test.ts` files (next to source) should
  migrate to the mirrored `tests/` layout when their surrounding
  code is touched.
- See [Testing patterns](/contributing/testing/) for the
  stubbed-DI helper and the `withTestDb` transaction wrapper.

## Async work

- **Async work goes through BullMQ on Redis**, consumed by
  `apps/backend/worker`. The api enqueues; it doesn't process
  long-running work inline.
- **Scheduled jobs use the advisory-lock wrapper** so overlapping
  fires of the same job name no-op. See
  [Adding a scheduled job](/contributing/adding-a-job/).

## Comments

- **Default to no comments.** Code is documentation; well-named
  identifiers do the explaining.
- Add a comment **only when the WHY is non-obvious** — a hidden
  constraint, a subtle invariant, a workaround for a specific bug,
  behaviour that would surprise a reader.
- Never explain WHAT the code does.
- Never reference the current task, fix, or callers ("used by X",
  "added for the Y flow") — those belong in the PR description
  and rot as the codebase evolves.

## Suppression

- **No `@ts-ignore` / `@ts-expect-error` / `biome-ignore` without
  a one-line justification.** If you can't articulate the reason,
  fix the underlying problem instead.

## Dead code

- **No dead code, no stubs, no half-finished implementations.**
  If a feature is removed, delete the code. Don't leave commented
  blocks, `// TODO: implement`, or "kept for backwards
  compatibility" shims when nothing actually needs them.

## Env var ownership

- **Apps own app-level env vars.** App's `envSchema` validates
  them at boot.
- **Packages own package-level env vars** (e.g.
  `@scani/security` owns `ENCRYPTION_KEY`, `@scani/storage` owns
  `S3_*`, `@scani/email` owns `FASTMAIL_API_TOKEN` /
  `SMTP_URL`). Each has its own `src/config.ts` with a `loadX()`
  loader and `resetX()` for tests.
- **Apps must NOT redeclare a package's env vars.** The package
  owns validation; the app just sets the variable and trusts the
  package's loader.

See [Environment variables reference](/reference/environment/)
for the full split.

## Dependency hygiene

- `bun run deps:lint` — syncpack: workspace alignment, single
  version per external dep, caret ranges.
- `bun run deps:fix` — auto-fix.
- `bun run deps:unused` — knip: surfaces unused exports / files /
  deps.
- CI runs both whenever lockfile/config files change.

## Before pushing

Always:

```sh
bun run type-check
bun lint:fix
bun test --preload ./packages/business/domain/test-preload.ts \
  packages/ --timeout 30000
```

If you touched deps:

```sh
bun run deps:lint
bun run deps:unused
```

## See also

- [How to contribute](/contributing/how-to/)
- [Dependency injection pattern](/contributing/di-pattern/)
- [Testing patterns](/contributing/testing/)
- The canonical spec: [`CLAUDE.md`](https://github.com/MGrin/scani-oss/blob/main/CLAUDE.md)
