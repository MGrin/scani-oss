<!-- Thanks for the PR! Filling this in carefully gets it merged faster. -->

## What changed

<!-- One short paragraph. What does this PR do, in plain English? -->

## Why

<!-- The problem this solves, or the user-visible improvement. Link the
     issue this closes if one exists: `Closes #123`. -->

## How was this tested

<!-- Unit tests added? Manually verified against the local dev stack?
     Provider-specific integration tested against a real account? Be
     specific — "tested locally" is not enough. -->

## Checklist

- [ ] I read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the relevant
  sections of [`CLAUDE.md`](../CLAUDE.md).
- [ ] `bun run type-check` passes.
- [ ] `bun lint:fix` leaves no fixes.
- [ ] `bun test --preload ./packages/business/domain/test-preload.ts packages/ --timeout 30000` passes.
- [ ] If I touched dependencies: `bun run deps:lint` and `bun run deps:unused` both pass.
- [ ] Commits are signed off with `git commit -s` (DCO trailer).
- [ ] No `@ts-ignore` / `@ts-expect-error` / `biome-ignore` without a
  one-line justification comment.

## Screenshots / videos (UI changes)

<!-- For frontend changes, show the before/after. Drag images directly
     into the PR body. -->

## Anything reviewers should pay extra attention to

<!-- Tricky bits, parts you're unsure about, follow-ups you're aware of
     but didn't tackle here. -->
