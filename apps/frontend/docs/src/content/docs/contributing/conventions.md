---
title: Engineering conventions
description: The non-negotiable rules contributors ship against in this repo. Mirrors CLAUDE.md.
---

These are non-negotiable. Code that violates them should be either fixed in
place or rejected at review. The full canonical version lives in
[`CLAUDE.md`](https://github.com/MGrin/scani-oss/blob/main/CLAUDE.md); this
page is a contributor-friendly mirror.

## Toolchain

- **Bun runtime only.** No `npm` / `pnpm` / `yarn`. Use `bun install`,
  `bun run`, `bun test`, `bun build`. Don't reach for Node-specific APIs
  when a Bun primitive exists (`Bun.file`, `Bun.serve`, `Bun.$`, …).
- **Type-check via `tsgo`** (`@typescript/native-preview`). Every workspace's
  `type-check` script must call `tsgo --noEmit` — do not regress to plain
  `tsc`. tsgo is dramatically faster on this monorepo.
- **Lint via Biome** (`biome.json` at root). No ESLint, no Prettier, no
  parallel formatter. `bun lint:fix` is the only formatting/linting
  command.

## Imports

- **Top-level imports only.** No `await import(...)`, no `require()`. If a
  module needs lazy initialization, restructure the boot sequence so
  dependencies are statically resolvable.

## Code shape

- **SOLID, OOP, DRY.** Domain logic lives in `@Service()`-decorated classes
  with class-field DI (see below). One responsibility per class. Compose
  over inherit. If two callers reach for the same logic, promote it into
  the appropriate `packages/*` rather than copy-pasting.
- **No `@ts-ignore` / `@ts-expect-error` / `biome-ignore`** without a
  one-line justification comment. If you can't articulate the reason, fix
  the underlying problem.
- **Code is documentation.** Default to no comments. Add one only when the
  WHY is non-obvious — a hidden constraint, a subtle invariant, or a
  workaround for a specific bug. Never explain WHAT the code does.
- **No dead code, no stubs, no half-finished implementations.** If a
  feature is removed, delete the code. Don't leave commented blocks,
  `// TODO: implement`, or "kept for backwards compatibility" shims.

## Tests

- **Runner:** `bun test`. No Jest, no Vitest.
- **Layout:** tests live in `tests/` next to `src/`, mirroring the source
  tree — e.g.
  `packages/business/domain/tests/services/HoldingService.test.ts` for
  `packages/business/domain/src/services/HoldingService.ts`. New tests
  must use this layout.
- **Preload:** shared preload at
  `packages/business/domain/test-preload.ts` — loads `reflect-metadata`
  and sets a default `DATABASE_URL` pointed at the docker-compose
  Postgres.
- **Per-test isolation:** repository tests wrap each body in a transaction
  via `withTestDb` and roll back on exit, so suites can run in parallel
  against the same DB.

## Dependency injection (the trap)

Use **class-field DI**, not constructor-param injection. Bun's TypeScript
transpiler does not emit `design:paramtypes` reflect-metadata for
decorators; typedi falls back to injecting its own `ContainerInstance` into
every constructor param, which "works" until runtime.

```ts
// ✅ Correct
@Service()
export class MyService {
  private readonly repo = Container.get(MyRepository);
  private readonly other = Container.get(OtherService);
}

// ❌ Wrong — silently broken at runtime
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository,
    private readonly other: OtherService,
  ) {}
}
```

**Testing services that use class-field DI:** seed stubs on the Container,
then construct a fresh instance. Don't `Container.reset()` /
`Container.remove()` — either wipes the `@Service()` registration.

```ts
function makeService(stubDep: Dep): MyService {
  Container.set(MyRepository, stubDep);
  const instance = new MyService();      // class-field initializers run now,
  Container.set(MyService, instance);    // reading the stub we just set
  return instance;
}
```

See `packages/business/domain/src/services/HoldingService.ts` as a canonical
example.

## Async work

- **All async work goes through BullMQ on Redis**, consumed by
  `apps/backend/worker`. The api enqueues; it doesn't process long-running
  work inline.

## Env vars

Two layers, with a strict ownership rule:

- **App-level** (`apps/*/src/config/env.ts`) owns env vars that belong to
  the *app itself* — its bind port, its database connection, its frontend
  origin.
- **Package-level** (`packages/infra/<pkg>/src/config.ts`) owns env vars
  that belong to *that package* — `FASTMAIL_API_TOKEN` for `@scani/email`,
  `S3_*` for `@scani/storage`, `ENCRYPTION_KEY` for `@scani/security`.

Apps that depend on a package **do not redeclare** that package's env vars
in their own schema.

## Before pushing

Always run:

```bash
bun run type-check                                                          # parallel tsgo --noEmit across all workspaces
bun lint:fix                                                                # Biome
bun test --preload ./packages/business/domain/test-preload.ts packages/ --timeout 30000

# When dependencies changed
bun run deps:lint    # syncpack — version alignment
bun run deps:unused  # knip — unused exports/files/dependencies
```
