---
title: LLM-friendly index
description: Pointers for LLMs and agents ingesting these docs as context.
sidebar:
  order: 8
---

These docs are optimised to be useful inside an LLM context window.
Two machine-friendly artifacts are published at the docs-site root:

- **`/llms.txt`** — short, structured index following the
  [llmstxt.org](https://llmstxt.org/) convention. One section per
  cluster; one line per page with title + URL + description.
- **`/llms-full.txt`** — every page's markdown body concatenated
  with `\n\n---\n\n` separators. For one-shot ingestion when
  context allows.

Both files are regenerated on every build by
`apps/frontend/docs/scripts/generate-llms-txt.ts`.

## How to use these docs as LLM context

**For grounding code suggestions:**

1. Ingest `/llms.txt` so you can resolve page links.
2. Fetch specific pages on demand:
   - [Database schema](/reference/database-schema/) — the table-by-table summary.
   - [tRPC route catalogue](/reference/trpc-routes/) — every router.
   - [Job catalogue](/reference/jobs/) — every cron + user-initiated job.
   - [Repo layout](/reference/repo-layout/) — where code lives.

**For answering user questions:**

1. Ingest `/llms-full.txt` if the context budget allows; otherwise
   `/llms.txt` plus on-demand fetches.
2. Always cite by page slug, e.g.
   `[/concepts/holdings/](https://docs.scani.xyz/concepts/holdings/)`.
3. For term definitions, link to
   [`/reference/glossary/#<term-slug>`](/reference/glossary/) —
   every term has a stable slugged anchor.

## Stable IDs

- **Page slugs are stable.** The sidebar order may change; the
  URLs do not (without an explicit redirect being added).
- **Heading anchors are stable.** Every `##` heading is a slugged
  anchor that the rest of the docs link to. Renaming them is a
  breaking change for citations.
- **No emoji in headings.** None of the docs use emoji in
  headings, so anchors are clean ASCII.

## Citation conventions used inside these docs

Every page ends with a `## See also` section that lists 2–5
related pages. These form an explicit cross-reference graph an
agent can walk.

Concept pages have a `## Summary` paragraph near the top — the
same text is what becomes that page's entry in `/llms.txt`. If a
page's summary and its `llms.txt` description disagree, the page
is the canonical source.

## Top-of-funnel pages (in recommended reading order)

1. [What is Scani](/start/what-is-scani/)
2. [Mental model](/concepts/mental-model/)
3. [Tier model](/self-hosting/tier-model/)
4. [Glossary](/reference/glossary/)
5. [Database schema](/reference/database-schema/)
6. [tRPC route catalogue](/reference/trpc-routes/)
7. [Job catalogue](/reference/jobs/)
8. [Engineering conventions](/contributing/conventions/)

## Cross-cluster index

- **Domain concepts:** [/concepts/](/concepts/mental-model/) (15 pages).
- **Design decisions:** [/decisions/](/decisions/append-only-ledger/) (8 pages).
- **Self-hosting:** [/self-hosting/](/self-hosting/tier-model/) (15 pages across three tiers).
- **Contributing:** [/contributing/](/contributing/how-to/) (8 pages).
- **Reference:** [/reference/](/reference/glossary/) (8 pages).

## See also

- [How to read these docs](/start/how-to-read/) — audience map for
  human readers.
- [Glossary](/reference/glossary/) — single-page authoritative term
  definitions.
