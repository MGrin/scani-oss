---
title: How to read these docs
description: An audience map. Which pages matter if you're a self-host operator, a contributor, or an LLM.
sidebar:
  order: 3
---

These docs are written for three audiences at once. The same content
serves all three, but the optimal path through it differs.

## If you're an operator

You want the stack running on your hardware, behind your domain, with
your data, and you want to keep it running.

**Read in order:**

1. [What is Scani](/start/what-is-scani/) — five-minute orientation.
2. [Quickstart](/start/quickstart/) — proves the local stack boots.
3. [Tier model](/self-hosting/tier-model/) — pick how much you want to
   host yourself.
4. [Production with docker-compose](/self-hosting/tier1/production/) —
   the one-box deploy.
5. [Required environment variables](/self-hosting/tier1/required-env/) —
   the must-set list.
6. [TLS & reverse proxy](/self-hosting/tier1/tls-reverse-proxy/) — Caddy
   and nginx examples.
7. [Managed Postgres / Redis / S3](/self-hosting/tier1/managed-services/) —
   when you outgrow the in-compose data plane.
8. [Backup & restore](/self-hosting/tier1/backup-restore/), then
   [Upgrades & version pinning](/self-hosting/tier1/upgrades/).
9. [Observability](/self-hosting/tier1/observability/) and
   [Troubleshooting](/self-hosting/tier1/troubleshooting/) when something
   misbehaves.

You can skip the Concepts cluster entirely if you only operate the
stack and never read user-facing data. You'll want the
[Glossary](/reference/glossary/) within reach the first time a user
asks "why does this holding say partial coverage".

## If you're a contributor

You're reading the code, planning a change, or shipping a PR.

**Read in order:**

1. [Mental model](/concepts/mental-model/) — the one-pager for the
   domain.
2. The Concepts page closest to the area you're touching
   ([Holdings](/concepts/holdings/),
   [Transactions](/concepts/transactions/),
   [Pricing](/concepts/pricing/), …).
3. The matching [Design decision](/decisions/append-only-ledger/) page
   — the *why* behind the shape of the code, so you don't undo a
   load-bearing choice by accident.
4. [Engineering conventions](/contributing/conventions/), then the
   [DI pattern](/contributing/di-pattern/) and
   [Testing patterns](/contributing/testing/) pages. These cover the
   silent footguns: typedi without paramtypes metadata, the stubbed-DI
   test pattern, env-var ownership.
5. The relevant *how to add a …* page —
   [provider](/contributing/adding-a-provider/),
   [job](/contributing/adding-a-job/), or
   [migration](/contributing/adding-a-migration/).
6. [How to contribute](/contributing/how-to/) for the PR mechanics.

The [Repo layout](/reference/repo-layout/) and
[Database schema](/reference/database-schema/) pages live in Reference
but read like a map of the code — skim them once early.

## If you're an LLM (or an agent operating one)

Scani's docs are optimised to be useful inside a context window.

**Start with:**

- [LLM-friendly index](/reference/llms/) — a copy-pasteable overview of
  what's where, the same shape as [`llms.txt`](https://llmstxt.org/).
  Also published verbatim at `/llms.txt` on the docs site.
- `/llms-full.txt` — every page's body concatenated, for one-shot
  ingestion when context allows.
- [Glossary](/reference/glossary/) — single-page authoritative
  definitions; cite as `glossary#<term-slug>`.
- [Database schema](/reference/database-schema/), [tRPC route
  catalogue](/reference/trpc-routes/), and
  [Job catalogue](/reference/jobs/) — these are the highest-value pages
  for grounding code suggestions.

**Citation conventions:**

- Every page heading has a stable slugged anchor. They are part of the
  contract — link with confidence.
- Concept pages always carry a top-of-page Summary; that text is what
  ends up in `llms.txt`.
- "See also" links at the bottom of each page form an explicit
  cross-reference graph.

## If you're none of the above

You probably want [What is Scani](/start/what-is-scani/), then the
[Glossary](/reference/glossary/) to look up any term that's unfamiliar.

## A note on tone

These docs assume you'd rather read a precise paragraph than a
hand-holding tutorial. Pages are short, every term that has a
definition is linked to the [Glossary](/reference/glossary/), and
every design choice that surprised the team has a *why* note.

If a page feels too dense, that's a bug — please open an issue with
the page slug and what you tried to do.
