# Contributing to Scani

Thanks for your interest in working on Scani. This document is a short
on-ramp; the canonical engineering guide lives in
[`CLAUDE.md`](./CLAUDE.md) — read that before opening anything
non-trivial. It is treated as load-bearing by every contributor (human
or agent) in this repo.

## Filing issues

- **Bug?** Use the [Bug report](.github/ISSUE_TEMPLATE/bug.yml) template.
  Include reproduction steps, what you expected, what you saw, and your
  environment (OS, Bun version, whether you're running self-hosted or
  pointing at a hosted data-provider).
- **Feature idea?** Use the [Feature request](.github/ISSUE_TEMPLATE/feature.yml)
  template. Tell us the problem first, the proposed solution second.
- **Security finding?** Do **not** open a public issue. See
  [`.github/SECURITY.md`](./.github/SECURITY.md) for the private
  disclosure flow.

## Local development

The full local quickstart lives in [`README.md`](./README.md#self-hosting).
The short version:

```bash
git clone git@github.com:MGrin/scani-oss.git
cd scani-oss
cp .env.example .env
bun install
bun run dev:stack      # boots Postgres, Redis, MinIO, Mailpit, api, worker, data-provider, frontend
open http://localhost:5173
```

You'll need [Bun](https://bun.sh) ≥ 1.3 and Docker (Docker Desktop,
OrbStack, or any compatible runtime).

## Project conventions

Full project conventions live in [`CLAUDE.md`](./CLAUDE.md). It covers
the things you'll trip over if you skip it: the class-field DI pattern
(typedi + Bun's decorator-metadata gap), the test-isolation pattern
(`withTestDb` + per-test rollback), env-var ownership (apps own
app-level vars, packages own package-level vars), the no-comments-by-default
style. Agents working in this repo should treat it as the spec they
ship against.

A few highlights so you know what you're walking into:

- **Bun runtime end-to-end.** No `npm` / `pnpm` / `yarn`. Use `bun install`,
  `bun run`, `bun test`.
- **Type-check via `tsgo`** (`@typescript/native-preview`) — every workspace's
  `type-check` script calls `tsgo --noEmit`, not `tsc`.
- **Lint via Biome.** No ESLint, no Prettier. `bun lint:fix` is the only
  formatting/linting command.
- **Top-level imports only.** No `await import(...)`, no `require()`.
- **Tests live in `tests/` next to `src/`** — mirrored layout, never
  inline with source.
- **No `@ts-ignore` / `@ts-expect-error` / `biome-ignore` without a
  one-line justification.**

## Pull-request flow

1. **Fork** the repo and create a topic branch:
   ```bash
   git checkout -b your-name/short-descriptive-name
   ```
2. **One logical change per PR.** A bug fix, a single new feature, a
   refactor — not all three at once.
3. **Run the checks locally** before pushing:
   ```bash
   bun run type-check
   bun lint:fix
   bun test --preload ./packages/business/domain/test-preload.ts packages/ --timeout 30000
   ```
   If you touched dependencies:
   ```bash
   bun run deps:lint    # syncpack — version alignment
   bun run deps:unused  # knip — unused exports/files/dependencies
   ```
4. **Sign off your commits** with the Developer Certificate of Origin
   (DCO):
   ```bash
   git commit -s -m "your message"
   ```
   This adds a `Signed-off-by: …` trailer and certifies you have the
   right to contribute the work under the project's MIT license.
5. **Open the PR.** Use the
   [PR template](./.github/PULL_REQUEST_TEMPLATE.md). Link the issue
   it closes if one exists. Wait for CI green.
6. **Code review** is a conversation; expect questions and small change
   requests. Maintainers aim to first-review within a few days.

## What kinds of contributions are most welcome

- **Provider integrations.** Exchange + brokerage + chain adapters in
  `packages/clients/providers/`. Every exchange has quirks; we've only
  normalized a fraction of what users want.
- **Translations.** The SPA's UI strings live in
  [`apps/frontend/app/src/i18n/locales/`](./apps/frontend/app/src/i18n/locales/) —
  one JSON file per language, English as the source of truth. Drop a
  new `<code>.json` next to `en.json` and the language picker in
  Settings auto-discovers it. Partial translations are welcome; missing
  keys fall back to English. See
  [`locales/CONTRIBUTORS.md`](./apps/frontend/app/src/i18n/locales/CONTRIBUTORS.md)
  for the step-by-step.
- **Bug fixes** with a regression test.
- **Documentation.** README clarifications, package-level READMEs,
  better self-host instructions.
- **Performance.** Profile-driven; show the before/after numbers.

## What we'll likely close

- Sweeping refactors with no behaviour change and no benchmark wins.
- Drive-by formatter / lint reflows. `bun lint:fix` handles those.
- Adding new linters, formatters, or test runners.
- "Add framework X" PRs without an issue agreeing on the direction
  first.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
