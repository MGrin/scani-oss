# YYYY-MM-DD — <one-sentence incident headline>

## Summary

| Field | Value |
|---|---|
| Date | YYYY-MM-DD |
| Duration | _e.g. 5h (15:00 → 20:00 UTC); partial recovery from 18:30 onwards_ |
| Services affected | _e.g. scani-data-provider, scani-backend_ |
| Customer-visible impact | _what users actually saw — 502s, slow responses, wrong data, etc._ |
| Root cause (proximal) | _the immediate technical cause_ |
| Root cause (distal) | _the deeper "why did this happen at all"_ |
| Triggering change | _PR / commit / config change that introduced the bug_ |

## Timeline (UTC)

| Time | Event |
|---|---|
| HH:MM | _Triggering deploy / config change_ |
| HH:MM | _First user / monitor signal_ |
| HH:MM | _Investigation start_ |
| HH:MM | _Mitigation deployed_ |
| HH:MM | _Full recovery_ |

## Root cause

_Detailed explanation. Distinguish proximal (the throw, the bad config, the
crash-loop) from distal (why was it possible to reach this state?). When
the distal cause is unknown, list open hypotheses and what would
distinguish them._

## What worked

- _Things in the existing tooling / process that reduced the impact._
- _Diagnostic tools that gave real signal._
- _Communication channels that surfaced the issue fast._

## What didn't work

- _Things that delayed diagnosis or made it worse._
- _Defensive measures that backfired._
- _Tools that were missing or unreliable._

## Action items

Use ✅ for shipped, 🟡 for in-flight, 🔲 for not-yet-started.

- ✅ / 🟡 / 🔲 **A1**. _Specific, actionable change with owner and PR/commit if shipped._

## What would have caught this earlier?

_Hypothetical: if we already had X tool / Y process / Z guard, would
this incident have happened? Use this section to identify
prophylactic investments worth making._

## Lessons for future code review

_When reviewing a PR that touches < class of code >, check for < pattern
that would prevent recurrence >. This is the "rule of thumb" extracted
from the incident._
