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

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see
[`LICENSE`](https://github.com/MGrin/scani-oss/blob/main/LICENSE)).
