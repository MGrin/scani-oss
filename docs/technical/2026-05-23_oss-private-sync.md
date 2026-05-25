# OSS ↔ private sync flow

**Direction of authority**: `MGrin/scani-oss` (public, MIT) is **upstream**;
`MGrin/scani` (this repo, private) is **downstream**. Every OSS-eligible
change lands in `scani-oss` first, then flows down here via a merge.

## Repos

| Repo | Path | Contents |
|---|---|---|
| `MGrin/scani` | this repo | Full tree — OSS-eligible code **plus** the private overlay (`infra/`, `apps/frontend/admin`, `apps/frontend/cloud`, `apps/frontend/landing`, `packages/infra/analytics`, `docs/`, ops workflows, fly.toml files, future billing) |
| `MGrin/scani-oss` | https://github.com/MGrin/scani-oss | The OSS subset. Same engine + SPA. MIT licensed. |

In this clone, `upstream` is the remote pointing at `scani-oss`:

```bash
git remote -v
# origin    https://github.com/MGrin/scani.git
# upstream  https://github.com/MGrin/scani-oss.git
```

## Daily flow

### Making an OSS-eligible change

A change is OSS-eligible if it touches anything under:

- `apps/backend/{api,worker,data-provider}` (the four files in the
  "Analytics-divergent" set below are nuanced — see below)
- `apps/frontend/app`
- All `packages/*` **except** `packages/infra/analytics`
- Root tooling: `biome.json`, `tsconfig.json`, `knip.json`, `.syncpackrc.json`, `bunfig.toml`, `scripts/sync-env.ts`, `scripts/generate-ci-filters.ts`
- `.github/workflows/ci.yml`, `.github/workflows/coverage.yml`, `.github/workflows/security-invariants.yml`

For these:

1. **Branch from `MGrin/scani-oss/main`**, not from `origin/main` here.
2. Open the PR against `MGrin/scani-oss`. Get CI green there and merge.
3. Wait for the next sync (automatic — see "Recurring sync" below) or
   manually trigger it. The change shows up in `origin/main` of the
   private repo as part of a `sync:` merge commit.

### Making a private-only change

A change is private-only if it touches anything under:

- `apps/frontend/{admin,cloud,landing}`
- `infra/`
- `packages/infra/analytics/`
- `apps/backend/*/fly.toml`
- `.github/workflows/{deploy-fly,terraform,fly-diagnostics,backup-db,restore-test,rollback,capture-screenshots,sync-oss-upstream,oss-drift-check}.yml`
- `docs/`
- Anything in the "merge=ours allowlist" below (those are intentionally
  divergent between the repos)

For these:

1. Branch from `origin/main` (this repo).
2. PR here as normal.
3. CI doesn't touch the OSS repo.

### Making a cross-cutting change (both)

When a feature spans OSS-eligible code AND private-only code (e.g.,
billing — adds a router on `apps/backend/api/` that's OSS-eligible AND
new private-only billing migrations):

1. **First** open the OSS-eligible part as a PR against `MGrin/scani-oss`.
2. After it lands in OSS, **sync** the change down here.
3. **Then** open the private-only part as a PR here, branching from
   `origin/main` after the sync has merged.

The reason for OSS-first: if the private piece lands first and the OSS
piece lands later with a different shape, the sync merge will surface
the divergence as a conflict — and the resolution must be "private
adopts OSS's shape", which gets messy. Doing OSS first is cheaper.

## Merge=ours allowlist (`.gitattributes`)

These files diverge intentionally between the two repos and the private
side is canonical. The `merge.ours.driver = true` config + `merge=ours`
attribute pin every sync merge to keep this side's version, silently.

| File | Why divergent |
|---|---|
| `package.json` | Private workspaces include `apps/frontend/admin/cloud/landing` and `packages/infra/analytics` |
| `docker-compose.yml` | Private compose has admin/cloud/landing services + `scani-*` container_name prefixes |
| `README.md` | Private has internal-flavored docs; OSS has the public-audience rewrite |
| `CONTRIBUTING.md` | Same — private is internal, OSS is public-facing |
| `CLAUDE.md` | Private has the Conductor workflow + secret-path + internal infra sections; OSS is scrubbed |
| `.github/CODEOWNERS` | Private references `infra/terraform/` and `apps/frontend/admin/`; OSS has a simplified version |
| `.github/workflows/ci.yml` | Private has more path filters (admin/cloud/landing/analytics paths) |
| `.github/workflows/security-invariants.yml` | Private has the A-04 admin-bypass guard step; OSS doesn't |
| `.githooks/pre-commit` | Private runs `terraform fmt`; OSS doesn't (no `.tf` files) |
| `.env.example` (root + per-app) | Private has production URLs and the admin-app section; OSS has placeholder URLs |
| `apps/backend/data-provider/src/presentation/router.ts` | Private registers the `waitlist` sub-router; OSS doesn't |

The list lives in [`.gitattributes`](../../.gitattributes); change the
file and `merge=ours` takes effect immediately on the next sync.

## Analytics-divergent files (normal merge, NOT merge=ours)

The PostHog full-strip leaves ~9 files different between OSS
(analytics-free) and private (analytics-woven). These are **deliberately
kept out of `merge=ours`** because they're actively-developed core
files — `merge=ours` would silently discard every OSS bug-fix to them.

Instead they merge with a normal 3-way merge: git auto-resolves whenever
an OSS change and the private analytics overlay touch different hunks
(the common case). When a conflict appears in the analytics hunk
specifically, the resolution is "keep both sides" — the OSS change plus
the private analytics lines.

The set:

- `packages/infra/email/src/email-service.ts`
- `apps/backend/api/src/index.ts`
- `apps/backend/api/src/auth/better-auth.ts`
- `apps/backend/api/src/presentation/routers/integrations.ts`
- `apps/backend/worker/src/index.ts`
- `apps/backend/worker/src/processors/exchange-import.ts`
- `apps/backend/data-provider/src/index.ts`
- `apps/frontend/app/src/main.tsx`
- `apps/frontend/app/src/App.tsx`
- (`apps/frontend/app/src/components/AnalyticsBridge.tsx` — private-only,
  not actually divergent — OSS deleted it like `waitlist.ts`)

When opening a PR that touches one of these in the analytics overlay
without an upstream link, the `oss-drift-check.yml` workflow (Phase 4)
will fail — bypass with the `bypass-oss-drift` label.

## bun.lock

`bun.lock` diverges because private carries `posthog-js` / `posthog-node`
that OSS doesn't. **Do not `merge=ours` it** — regenerate it at the end
of every sync merge:

```bash
bun install                       # picks up private's package.json shape
git diff --stat bun.lock          # if anything changed, stage it
git commit --amend --no-edit      # fold into the merge commit
```

## Recurring sync

`.github/workflows/sync-oss-upstream.yml` runs daily at 08:00 UTC and on
`workflow_dispatch`:

1. `git fetch upstream && git merge --no-ff upstream/main` onto a fresh
   `automation/sync-oss-YYYYMMDD` branch.
2. The `merge.ours.driver` resolves every file in the `merge=ours`
   allowlist silently (private's version wins).
3. **Conflict policy for everything else** — the workflow handles the
   three remaining unmerged states distinctly:
   - **UU (both modified)** → leave the conflict markers in place,
     `git add` them, commit as-is. CI fails (markers don't parse). A
     reviewer must pull the branch, resolve each file by hand, and
     force-push. **Never `git checkout --ours`** — that path silently
     dropped OSS work and shipped broken trees (see PR #577 post-mortem).
   - **DU (we deleted, they modified)** → `git rm`. These are files
     private intentionally dropped from the OSS subset (Docker publish
     workflow, release-please artifacts).
   - **UD (we modified, they deleted)** → `git add` of our version.
4. Open the PR. If any UU paths were present, the PR body lists them
   under "Manual resolution required", labels with `needs-human-review`,
   and includes the verbatim commands a reviewer should run to resolve.

### Reviewer playbook for a UU-conflict sync PR

```bash
git fetch origin automation/sync-oss-YYYYMMDD
git checkout automation/sync-oss-YYYYMMDD
# For each file with markers: pick the OSS-side bug fixes AND the
# private overlay (analytics imports, waitlist routes, branding).
# See the analytics-divergent set above for which lines belong to
# which side.
bun run type-check
bun lint:fix
bun test --preload ./packages/business/domain/test-preload.ts packages/
git add -A && git commit -m "sync(reconcile): manual merge"
git push --force-with-lease origin automation/sync-oss-YYYYMMDD
```

A second workflow `.github/workflows/oss-drift-check.yml` (also coming)
runs on every private PR and asserts: if a PR touches an OSS-eligible
path, its body must reference an upstream PR (`MGrin/scani-oss#N` or
`scani-oss/pull/N`). The `bypass-oss-drift` label overrides — used for
analytics-overlay-only edits to the divergent set.

## Initial graft (this commit)

The first merge was done manually:

```bash
git checkout -b MGrin/sync-oss-initial
git fetch upstream
git merge --allow-unrelated-histories upstream/main \
  -m "sync: initial graft from MGrin/scani-oss"

# 56 add/add conflicts (no common ancestor → merge=ours driver can't fire).
# Resolution: keep private's version everywhere — private's tree is what
# actually runs in production; OSS is a derived artifact:
git diff --name-only --diff-filter=U | xargs git checkout --ours --
git add -A

bun install
bun run type-check && bun lint
git commit --no-edit
```

Future syncs **do** have a common ancestor (this merge commit), so the
`merge=ours` driver fires and conflicts are limited to the
analytics-divergent set + anything genuinely both-sides-modified.

## Troubleshooting

**Q: I opened a PR against the OSS repo and CI is unhappy because it
imports something private-only.**

You hit a layering bug. The OSS subset must not import anything from
the private overlay. Check `packages/infra/analytics/` references —
that's the most common offender.

**Q: The sync workflow merged but private CI fails.**

Likely an analytics-divergent file has a real conflict that
auto-resolution dropped lines from. Pull the sync branch locally,
inspect the affected file, manually reconcile the analytics overlay
on top of the OSS change, push the fix to the sync branch.

**Q: I want to make an OSS change but I'm on the private repo's
checkout.**

Add the OSS repo as a remote and work against it from this checkout:

```bash
git fetch upstream
git checkout -b your-name/oss-fix upstream/main
# edit, commit
git push upstream your-name/oss-fix      # opens PR on scani-oss
```

Or just clone `MGrin/scani-oss` into a separate directory. Either works.
