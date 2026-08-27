#!/usr/bin/env bash
#
# `bun run oss:pr-ready` — a stand-in that says the check is not here.
#
# The pull-request readiness check reads a pull request's CI state and decides
# whether it may be merged. It is a maintainer tool and it is not part of this
# repository; nothing here needs installing or configuring to build, test or
# contribute.
#
# WHY THIS FILE EXISTS AT ALL. Without it `bun run oss:pr-ready` answers
# `Script not found`, which is true and useless: it reads as a typo in the
# script name, so the reader retries the raw path and gets a second true and
# useless message about a module that is missing. Both send someone looking for
# a broken checkout. This says the one thing neither of them does — that the
# check is not available here — which is what a reader actually needs in order
# to stop looking.
#
# EXIT 9 IS DELIBERATE. The real check reports its verdict in the exit code, and
# a caller polling for one must not read "unavailable" as either a pass or a
# still-running. 9 is neither, so a poller that retries only on "still running"
# stops here and reports, instead of looping until it times out with no
# diagnosis.
set -euo pipefail

printf 'oss-pr-ready: UNAVAILABLE · exit 9 · this check is not available in this repository; it is run by maintainers before a pull request is merged\n' >&2
exit 9
