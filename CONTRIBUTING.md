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

## Running the test suite

Scani has two test layers:

- **Unit + backend integration** (`bun test`): ~30s, only Postgres
  required. Run this on save and before pushing.
- **End-to-end** (`bun test:e2e`): full browser-driven Playwright suite
  against the real docker-compose stack. Slower (~5 min cold) but
  catches regressions across api / worker / frontend / data-provider
  that the unit suite can't see.

### First-time setup for e2e

```bash
bun install
cd apps/e2e && bunx playwright install --with-deps chromium webkit
```

### Running e2e

```bash
bun test:e2e
```

This autodetects whether the dev stack is already up:

- **If `bun dev:stack` is running**: tests run against it, no teardown.
- **Otherwise**: boots a temporary stack via docker-compose, runs the
  suite, tears it down on exit.

### Debugging

```bash
bun test:e2e:ui          # Playwright interactive UI mode (against an already-running stack)
bun test:e2e:report      # Open the HTML report from the last run
KEEP_STACK_ON_FAILURE=1 bun test:e2e   # Don't tear down on failure; inspect with `docker compose logs`
```

To debug a single spec:

```bash
cd apps/e2e
bunx playwright test tests/auth/otp-sign-in.spec.ts --project=chromium --headed
```

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
4. **Write a conventional-commit message** and **sign off** with the
   Developer Certificate of Origin (DCO):
   ```bash
   git commit -s -m "feat: add Kraken transaction adapter"
   ```
   The `-s` adds a `Signed-off-by: …` trailer (you certify you have the
   right to contribute under the project's MIT license). The prefix is
   load-bearing: [release-please](https://github.com/googleapis/release-please)
   watches `main` and opens a release PR off these prefixes, so use them
   honestly.

   | Prefix      | Meaning                                            | Triggers release? |
   |-------------|----------------------------------------------------|-------------------|
   | `feat:`     | New user-visible feature                           | yes — minor bump  |
   | `fix:`      | Bug fix                                            | yes — patch bump  |
   | `docs:`     | Docs-only change                                   | no                |
   | `refactor:` | Code change with no behaviour change               | no                |
   | `chore:`    | Tooling, deps, CI, build — no product change       | no                |

   Mark breaking changes with `!` after the type (`feat!: …`) or a
   `BREAKING CHANGE:` footer. While we're pre-1.0, breaking changes
   bump the minor (`0.X.0`), not the major — see
   `release-please-config.json` (`bump-minor-pre-major: true`).
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

## Contributor benefits

Every contributor with at least one merged, non-trivial pull request on
`scani-oss` gets free, permanent access to every paid tier of the hosted
Scani service at <https://app.scani.xyz>.

What this means in practice:

- **Eligibility**: any merged PR that materially changes the product —
  a bug fix with a regression test, a new provider integration, a
  language translation of meaningful coverage, a performance fix with
  before/after numbers, a documentation contribution beyond a one-line
  typo, a non-trivial refactor agreed in an issue first. Cosmetic-only
  changes (a single-line README typo, a whitespace reflow) don't
  qualify on their own — bundle them with substantive work.
- **What "paid tiers" means today**: the hosted service is currently in
  beta with no billing live. When paid tiers ship, your account is
  flagged as a contributor account on the same day and retains every
  paid tier indefinitely, with no further conditions. You do not have
  to keep contributing to keep access.
- **How to claim**: after your PR merges, email
  contributors@scani.xyz from the address on your GitHub account, or
  open an account at <https://app.scani.xyz> with that same email and
  mention the PR number. The maintainer flags the account manually
  during beta; this becomes automatic once billing ships.
- **If the hosted product is ever shut down**: the grant is
  forward-looking. If the hosted service stops operating there is
  nothing to grant — the OSS code is yours either way under MIT.

This is a unilateral commitment by the maintainer, not a contract. It
exists because the value of every contribution to `scani-oss` is
strictly larger than the marginal cost of a hosted seat, and saying so
in writing is the honest way to acknowledge that.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
