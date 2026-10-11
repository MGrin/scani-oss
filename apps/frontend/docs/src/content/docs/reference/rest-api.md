---
title: REST API
description: Read and change a portfolio over plain HTTP at /api/v1, with a personal access token.
sidebar:
  order: 9
---

`/api/v1` serves a portfolio to a script, a spreadsheet or a dashboard. Each
route is one of the tools Scani's MCP server offers an AI client, behind the
same token, the same limits, the same change log and the same undo.

The machine-readable contract is the OpenAPI document at
`/api/v1/openapi.json`. `/api/v1/docs` renders it. Both are served by the api
itself, without a token.

## Turn it on

The routes follow agent access. On a self-hosted instance set
`SCANI_AGENT_ACCESS=1` on the api. With it off, every route answers 403
`agent_access_off`.

## Tokens

Create a personal access token in the app under Settings, then send it on
every request:

```bash
curl -H "Authorization: Bearer scani_pat_…" https://<your-api>/api/v1/holdings
```

- A token reads everything the routes below read.
- A token created with **Allow changes** also writes.
- A token is shown once. Scani stores only its hash, so a lost token is
  revoked and replaced, not recovered.
- An account holds at most 10 live tokens.

A session cookie, a token in the query string and an OAuth access token are
not accepted.

## Routes

| Route | What it answers |
|---|---|
| `GET /api/v1/portfolio/summary` | Total value, counts, top holdings and allocation. |
| `GET /api/v1/portfolio/allocation` | Value split by one `dimension`. |
| `GET /api/v1/portfolio/returns` | Returns over a `window`: `ytd`, `1y` or `all`. Heavy. |
| `GET /api/v1/portfolio/net-worth` | Net worth over time, `from` and `to`. Heavy. |
| `GET /api/v1/portfolio/realized-gains` | Realized gains for one `holdingId`. Heavy. |
| `GET /api/v1/portfolio/data-quality` | What the data is missing: prices, coverage, duplicates. |
| `GET /api/v1/accounts` | Every account with its totals. |
| `GET /api/v1/holdings` | Every visible holding, optionally one `accountId`. |
| `GET /api/v1/lots` | Open tax lots, optionally for some `holdingIds`. Heavy. |
| `GET /api/v1/transactions` | Recorded movements, newest first. Paged by `limit` and `offset`. |
| `GET /api/v1/tokens` | Finds a currency, stock or crypto token by `query`. |
| `GET /api/v1/review-questions` | Open questions: unexplained transfers and balance changes. |
| `GET /api/v1/changes` | Every change a token made, and whether it was undone. |
| `POST /api/v1/movements` | Records money in, out, or between two accounts. |
| `POST /api/v1/holdings` | Creates up to 20 hand-entered holdings in one account. |
| `POST /api/v1/review-questions/transfers/{transactionId}/answer` | Answers one transfer question. |
| `POST /api/v1/review-questions/balance-gaps/{observationId}/answer` | Answers one balance question. |
| `POST /api/v1/changes/{agentChangeId}/undo` | Puts back every row one change touched. |

Parameter and field names are camelCase. A list parameter repeats its key:
`?holdingIds=a&holdingIds=b`. An unknown parameter or body field answers 400.

## Numbers and absent values

A quantity or a money amount is a decimal string, because a JSON number loses
digits. A field with no value is absent from the answer; it is never `null`.

## Limits

- 120 requests a minute per token, shared with that token's MCP use.
- The four routes marked Heavy share 12 requests a minute per user, across the
  user's tokens.
- A spent budget answers 429 with a `Retry-After` header in seconds.

## Changes, retries and undo

Every write answers `agentChangeId`, `rowsChanged` and the write's own
`result`.

**Undo.** `POST /api/v1/changes/{agentChangeId}/undo` puts every row back
exactly. It refuses with 409, changing nothing, when a later change touched
the same rows; undo that later change first.

**Retries.** Send an `Idempotency-Key` header on a write. The same key and
body writes once, and the repeat answers the first answer with
`replayed: true`. A different body under a used key answers 409. A key
belongs to its token, and a failed attempt keeps none, so its retry runs.

One write runs at a time per account. A second write that arrives while one
is running answers 409; retry it.

## Errors

```json
{ "error": { "code": "invalid_input", "message": "The request is not valid.", "issues": ["limit: Expected number, received string"] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_input` | A parameter or field is wrong. `issues` names each. |
| 401 | `unauthenticated` | No token, or one that is unknown or revoked. |
| 403 | `read_only_token` | A write with a token that only reads. |
| 403 | `agent_access_off` | Agent access is off for the account. |
| 403 | `forbidden` | The deployment refuses this change. |
| 404 | `not_found` | No such route, or an id that is not the token owner's. |
| 405 | `method_not_allowed` | The route exists under another method. |
| 409 | `conflict` | The change cannot be made as things stand. |
| 429 | `rate_limited` | A budget is spent. |
| 500 | `internal` | The request failed on the server. |

An id that belongs to another user answers 404, never 403, so the API does
not confirm that the id exists.

## Versioning

v1 only gains things: a route, an optional parameter, an answer field. A
client must ignore fields it does not know. A removal or a change of type is
`/api/v2`.

## Not in v1

- **File imports.** Use the app.
- **Full export.** Use the app's export.
- **Price history and per-account balance history.**
- **Token management.** A token cannot create or revoke tokens.
- **Editing or deleting a row.** There is no PATCH or DELETE; undo a change
  instead.
- **Advice.** The MCP tools `get_portfolio_analysis`, `plan_rebalance` and
  `get_suggestions` are worded for an AI model and are not routes.
