---
title: How to contribute
description: How to file an issue, write a PR, and get it merged.
sidebar:
  order: 1
---

Pull requests welcome. The canonical engineering spec is
[`CLAUDE.md`](https://github.com/MGrin/scani-oss/blob/main/CLAUDE.md);
read it before opening anything non-trivial. The summary below is
what you'll trip over most often.

## Filing issues

- **Bug?** Use the [bug template](https://github.com/MGrin/scani-oss/issues/new?template=bug.yml).
  Include reproduction steps, what you expected, what you saw, and
  your environment (OS, Bun version, tier).
- **Feature idea?** Use the [feature template](https://github.com/MGrin/scani-oss/issues/new?template=feature.yml).
  State the problem first, the solution second.
- **Security finding?** Do *not* open a public issue. See
  [`.github/SECURITY.md`](https://github.com/MGrin/scani-oss/blob/main/.github/SECURITY.md)
  for the private flow. Or email `security@scani.xyz`.

## Local setup

You need [Bun](https://bun.sh) ≥ 1.3 and Docker.

```sh
git clone git@github.com:MGrin/scani-oss.git
cd scani-oss
cp .env.example .env
bun install
bun run dev:stack      # the full local stack
open http://localhost:5173
```

See [Local development stack](/self-hosting/tier1/local-dev/) for
the details.

## PR flow

1. **Fork** and create a topic branch:
   ```sh
   git checkout -b your-name/short-descriptive-name
   ```
2. **One logical change per PR.** Don't bundle a bugfix, a refactor,
   and a new feature.
3. **Run the checks locally** before pushing:
   ```sh
   bun run type-check
   bun lint:fix
   bun test --preload ./packages/business/domain/test-preload.ts \
     packages/ --timeout 30000
   ```
   If you touched dependencies:
   ```sh
   bun run deps:lint    # syncpack
   bun run deps:unused  # knip
   ```
4. **Conventional-commit message + DCO sign-off:**
   ```sh
   git commit -s -m "feat: add Kraken transaction adapter"
   ```
   `-s` adds `Signed-off-by:` (DCO — certifying you have the right
   to contribute under MIT).
5. **Open the PR.** Use the
   [PR template](https://github.com/MGrin/scani-oss/blob/main/.github/PULL_REQUEST_TEMPLATE.md).
   Link the issue if one exists.

## Commit prefix → release effect

| Prefix | Triggers release? | Effect (pre-1.0) |
|---|---|---|
| `feat:` | Yes | Minor bump. |
| `fix:` | Yes | Patch bump. |
| `docs:` / `refactor:` / `chore:` | No | — |
| `feat!:` or `BREAKING CHANGE:` footer | Yes | Minor bump pre-1.0 (`bump-minor-pre-major: true`). |

Pick the prefix honestly — [release-please](https://github.com/googleapis/release-please)
watches `main` and cuts versions off these.

## What we're most interested in

- **New provider integrations.** Exchanges, brokerages, chains.
  See [Adding a provider](/contributing/adding-a-provider/).
- **Translations.** Drop a JSON file into
  [`apps/frontend/app/src/i18n/locales/`](https://github.com/MGrin/scani-oss/tree/main/apps/frontend/app/src/i18n/locales) —
  partial translations welcome.
- **Bug fixes with a regression test.**
- **Documentation.** README clarifications, conventions, this docs
  site.
- **Performance.** Profile-driven; show before/after numbers.

## What we'll likely close

- Sweeping refactors with no behaviour change and no benchmark wins.
- Drive-by formatter / lint reflows. `bun lint:fix` handles those.
- New linters, formatters, or test runners.
- "Add framework X" without an issue agreeing on direction first.

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

## Code review

Code review is a conversation; expect questions and small change
requests. Maintainers aim to first-review within a few days. If
your PR sits idle for more than a week, comment on it.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see
[`LICENSE`](https://github.com/MGrin/scani-oss/blob/main/LICENSE)).

## See also

- [Engineering conventions](/contributing/conventions/)
- [Dependency injection pattern](/contributing/di-pattern/)
- [Testing patterns](/contributing/testing/)
- [Adding a provider](/contributing/adding-a-provider/)
- [Adding a scheduled job](/contributing/adding-a-job/)
- [Adding a database migration](/contributing/adding-a-migration/)
- [Release flow](/contributing/release-flow/)
