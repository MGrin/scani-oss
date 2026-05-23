---
title: How to contribute
description: Filing issues, opening PRs, and what kinds of contributions are most welcome.
---

Thanks for your interest in working on Scani. This page is a short on-ramp.
The canonical engineering spec lives in
[Engineering conventions](/contributing/conventions/) — read that
before opening anything non-trivial.

## Filing issues

- **Bug?** Use the
  [Bug report](https://github.com/MGrin/scani-oss/blob/main/.github/ISSUE_TEMPLATE/bug.yml)
  template. Include reproduction steps, what you expected, what you saw,
  and your environment (OS, Bun version, whether you're self-hosted or
  pointing at a hosted data-provider).
- **Feature idea?** Use the
  [Feature request](https://github.com/MGrin/scani-oss/blob/main/.github/ISSUE_TEMPLATE/feature.yml)
  template. State the problem first, the proposed solution second.
- **Security finding?** Do **not** open a public issue. See
  [`.github/SECURITY.md`](https://github.com/MGrin/scani-oss/blob/main/.github/SECURITY.md)
  for the private disclosure flow.

## Local development

See [Quickstart](/quickstart/) for boot instructions. The short
version:

```bash
git clone git@github.com:MGrin/scani-oss.git
cd scani-oss
cp .env.example .env
bun install
bun run dev:stack
open http://localhost:5173
```

You need [Bun](https://bun.sh) ≥ 1.3 and Docker.

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

4. **Sign off your commits** with the Developer Certificate of Origin (DCO):

   ```bash
   git commit -s -m "your message"
   ```

   This adds a `Signed-off-by:` trailer and certifies you have the right to
   contribute the work under the project's MIT license.

5. **Open the PR** using the
   [PR template](https://github.com/MGrin/scani-oss/blob/main/.github/PULL_REQUEST_TEMPLATE.md).
   Link the issue it closes if one exists. Wait for CI green.

6. **Code review** is a conversation. Expect questions and small change
   requests. Maintainers aim to first-review within a few days.

## What kinds of contributions are most welcome

- **Provider integrations.** Exchange + brokerage + chain adapters in
  `packages/clients/providers/`. Every exchange has quirks; we've only
  normalized a fraction of what users want.
- **Bug fixes** with a regression test.
- **Documentation.** README clarifications, package-level READMEs, better
  self-host instructions, additions to this site.
- **Performance.** Profile-driven; show the before/after numbers.

## What we'll likely close

- Sweeping refactors with no behaviour change and no benchmark wins.
- Drive-by formatter / lint reflows. `bun lint:fix` handles those.
- Adding new linters, formatters, or test runners.
- "Add framework X" PRs without an issue agreeing on the direction first.

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
the MIT License (see
[`LICENSE`](https://github.com/MGrin/scani-oss/blob/main/LICENSE)).
