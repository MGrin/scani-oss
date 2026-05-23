---
title: Why the holding-inclusion rule lives twice
description: The dashboard headline must reconcile with the chart's latest point. Duplicating the rule in TS and SQL is a deliberate trade — one source of truth in two enforceable shapes.
sidebar:
  order: 5
---

## The decision

The rule for whether a [holding](/concepts/holdings/) counts toward a
portfolio total lives in **two** places:

- TypeScript, in `packages/business/domain/src/lib/holding-inclusion.ts`,
  consumed by `PortfolioValuationService` for the dashboard headline.
- SQL, inline in `PortfolioValueDailyRepository.findIncludedHoldingScopeRange`,
  for the historical chart read path.

Both express the same predicate: a holding is included if and only if
`isHidden = false`, `isActive = true`, and
`token.isScamProbability < SCAM_PROBABILITY_THRESHOLD`.

## The alternative we rejected

A single source — usually the TypeScript predicate — applied uniformly,
with the chart hydrating raw rows from SQL and filtering in
application code.

## Why we rejected it

**The chart query is hot.** It returns potentially thousands of
points across the date range, scoped by user / institution / account
/ holding. Hydrating every candidate row into TypeScript objects to
filter them in code would push tens of megabytes per request across
the wire from Postgres for what should be a small response. Pushing
the filter into SQL means the database returns only the rows that
matter.

**The dashboard headline is not hot in the same way.** It reads a
small set of in-flight holdings, all of which need to be present in
the application layer anyway (for the per-holding render). The
TypeScript predicate is the right shape there.

**The two paths used to drift.** Before the rule was extracted, the
dashboard read path and the chart read path each implemented their
own inclusion filter. Inevitably they drifted: hidden holdings were
sometimes included in the chart but excluded from the dashboard;
scam tokens did the opposite; the headline showed $X while the
chart's latest point showed $X + change. The duplication was
*already there* — the only thing missing was a canonical reference
both implementations agreed on.

## How the duplication is kept in sync

- The TypeScript predicate is the canonical reference.
  `holding-inclusion.ts` documents the rule and provides the
  function:

  ```ts
  export function isIncludedInTotal(holding, token) {
    if (holding.isHidden) return false;
    if (!holding.isActive) return false;
    if (token.isScamProbability >= SCAM_PROBABILITY_THRESHOLD) return false;
    return true;
  }
  ```

- The SQL inside `PortfolioValueDailyRepository.findIncludedHoldingScopeRange`
  has a `// NOTE` comment pointing at the TypeScript file and
  stating that the two must stay aligned.

- Tests on both code paths assert the headline and the chart's latest
  point agree for the same fixture data.

A future refactor could move the SQL into a Drizzle helper that
shares constants (the threshold) with the TypeScript predicate. The
current duplication is small and stable; that refactor is on the
nice-to-have list.

## What this design unlocks

- **Headline reconciles with the chart by construction.** That's the
  whole point.
- **The chart query stays in SQL.** Throughput wins.
- **The rule is documented in one canonical place** even though
  it's enforced in two.

## What the design costs

- **Two places to update** when the rule changes. In practice the
  rule has changed exactly once (the addition of the
  `isScamProbability` clause), and both sites were updated in the
  same PR.

## What this rules out

- A "show hidden holdings in the chart but not the dashboard" toggle.
  The rule is symmetric by design — the toggle would silently
  un-reconcile the two.
- A per-user override of the threshold. The threshold is a system
  constant. A future "user data-quality preferences" surface could
  expose it, but it would still apply identically to both paths.

## See also

- [Holdings](/concepts/holdings/)
- [Portfolio value rollup](/concepts/rollup/)
- [Glossary: inclusion rule](/reference/glossary/#inclusion-rule)
