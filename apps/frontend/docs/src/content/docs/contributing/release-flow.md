---
title: Release flow
description: How release-please cuts versions, how images get published, and what triggers what.
sidebar:
  order: 8
---

## The flow

```
PR merge (main) ──→ release-please opens / updates a release PR
                       │
                       │ (release PR merged)
                       ▼
                  semver git tag pushed (v0.7.2)
                       │
                       ▼
              docker-publish.yml workflow runs
                       │
                       ▼
        Multi-arch images pushed to Docker Hub:
          scani/api:0.7.2, :0.7, :0, :latest
          scani/worker:...
          scani/data-provider:...
          scani/frontend-app:...
```

## release-please

[`release-please`](https://github.com/googleapis/release-please) is a
GitHub Action that watches `main` for conventional-commit messages.
It maintains a "release PR" that accumulates the next version's
changelog and bumps the manifest.

| Commit prefix | Triggers release? | Bump |
|---|---|---|
| `feat:` | yes | minor |
| `fix:` | yes | patch |
| `feat!:` or `BREAKING CHANGE:` | yes | minor pre-1.0, major post-1.0 |
| `docs:`, `refactor:`, `chore:`, `test:`, `ci:` | no | — |

Configuration: `release-please-config.json`. Pre-1.0, the
`bump-minor-pre-major: true` setting promotes breaking changes to
minor bumps so the version number stays in the `0.x` series.

When the release PR merges, release-please pushes a git tag
(`v0.7.2`) which triggers the docker-publish workflow.

## PR titles are not changelog entries

Write pull-request titles as **plain sentences**. Keep the conventional prefix
on the **commits**, which is where release-please is meant to read it.

```
not   fix(redis): bound every Redis await on the api request path (SC-522)
but   Bound every Redis await on the api request path (SC-522)
```

Conventional-commit format is a contract about commits. A PR title is a human
label on a unit of review. Overloading one string with both jobs is what caused
this rule to be needed.

release-please walks the *full ancestry* of `main` rather than its first-parent
line — measured over the 0.15.0 window, 70 commits against 27 — so a merge
commit and every branch commit it landed are all read. GitHub writes the PR
title into the merge commit's message under all three title/message
combinations it permits, so a conventional title is read a second time and
attributed to the merge commit's sha. Every entry in the 0.15.0 release PR was
listed twice that way.

There is no release-please option for this — none of the config keys it reads
governs merge-commit reading — and no GitHub setting avoids it either:
`merge_commit_message: BLANK` is rejected with
`invalid_merge_commit_setting_combo` unless the title is also `PR_TITLE`, which
moves the title into the merge commit's subject rather than removing it.

So the rule is enforced in CI. `.github/workflows/pr-title.yml` runs
`scripts/check-pr-title.ts` on every title edit as well as on push, because a
title changed after CI goes green is the one the merge commit takes. That
script carries the measurement and, more usefully, the titles it *deliberately*
allows — `SC-522: …` and `feat!: …` both parse as conventional commits on their
own and neither can produce a duplicate, so tightening the check to a
conventional-commit parser would reject correct titles.

release-please's own release PR is exempt: its `chore(main): release X.Y.Z`
title is meant to reach the merge commit.

## Image publish

`.github/workflows/docker-publish.yml` builds four images on:

- Pushes to `main` — tags `:latest` and `:sha-<short>`.
- Semver tag pushes — tags `:1.2.3`, `:1.2`, `:1`, and `:latest`.
- PRs — builds amd64-only (no push) to catch image-build
  regressions early.
- `workflow_dispatch` — manual trigger.

Architectures: `linux/amd64` + `linux/arm64` on main/tag pushes.
PRs are amd64-only for speed.

Images published to Docker Hub under the `scani/` namespace:

- `scani/api`
- `scani/worker`
- `scani/data-provider`
- `scani/frontend-app`

The frontend image bakes `VITE_API_URL=/api` (a relative path) so
nginx can do the backend routing at runtime — no rebuild per
deployment.

## Conventional commit prefixes — the honest list

Use the prefix that *actually* describes the change. release-please
trusts it.

| Prefix | Use for | Examples |
|---|---|---|
| `feat:` | New user-visible feature. | Adding a Kraken adapter; adding the vaults dashboard. |
| `fix:` | Bug fix. | Wrong cost basis after a re-import; broken splash hero on mobile. |
| `refactor:` | Code change with no behaviour change. | Renaming a service; moving a helper. |
| `chore:` | Tooling, deps, CI, build. | Bumping Bun version; adding a CI step. |
| `docs:` | Docs-only change. | This entire docs site. |
| `test:` | Tests-only change. | Adding a regression test for a fixed bug. |
| `ci:` | CI / workflow changes. | New GitHub Actions job. |
| `perf:` | Performance improvement. | Two-query transfer matcher replacing N queries. |

`feat!:` / `fix!:` / `refactor!:` + `BREAKING CHANGE:` footer signal
a breaking change.

## DCO sign-off

Every commit needs a `Signed-off-by:` trailer — generated by
`git commit -s`. This is the Developer Certificate of Origin: you
certify you have the right to contribute the code under the
project's MIT license.

CI rejects PRs with unsigned commits.

## What to do when release-please opens a release PR

- **Don't merge it immediately.** Wait until CI is green and you've
  read the auto-generated changelog. The changelog is what users
  read when they upgrade — fix awkward wording before merging.
- **Don't add commits to the release PR.** release-please owns it
  and will rebase. If the changelog needs a fix, change the
  commit messages it draws from, not the release PR.
- **Don't merge the release PR while another release PR is open
  upstream.** release-please tracks state via labels; manually
  closing/reopening can desync.

## When you don't want a release

If you accidentally land a `feat:` commit that shouldn't trigger
a release (e.g. an internal-only change), follow up with an
empty commit:

```sh
git commit --allow-empty -m "chore: re-classify previous as internal"
```

…and edit the release PR's changelog entry to remove the spurious
feature. Awkward but rare.

## See also

- [How to contribute](/contributing/how-to/)
- [Upgrades & version pinning](/self-hosting/tier1/upgrades/)
- [Engineering conventions](/contributing/conventions/)
