# `saltedge/`

Bank balances and transactions through Salt Edge's account-information API
(v6), under Salt Edge's licence (SC-1244). The design and its open questions
are in `docs/technical/2026-09-19_saltedge-bank-aggregation-research.md`.

## Upstream

- Base: `https://www.saltedge.com/api/v6`.
- API ref: <https://docs.saltedge.com/v6/api_reference>.

## Capabilities

| Capability         | Endpoint                                                  | Notes                                                    |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| `current-balances` | `GET /connections?customer_id=…`, `GET /accounts?connection_id=…` | Active connections only; positive balances summed per currency. |
| `transactions`     | `GET /transactions?connection_id=…&account_id=…`          | Posted rows only; the sign decides deposit or withdrawal. |

Every list is cursor-paged: `meta.next_id` is sent back as `from_id`.

## Auth + env

- Platform credentials, not per-user: `SALTEDGE_APP_ID` and `SALTEDGE_SECRET`
  go in the `App-id` and `Secret` headers on every request.
- `SALTEDGE_PRIVATE_KEY` (PEM, optional until Live): signs each request with
  RSA-SHA256 over `Expires-at|METHOD|url|body`, sent as `Expires-at` and
  `Signature`. Its public half is uploaded to the Salt Edge dashboard.
- `SALTEDGE_BASE_URL` overrides the host, for tests.
- Per user, the only stored value is the Salt Edge `customerId`.
- Without an app id and a secret the factory reports the provider unkeyed and
  registers one that claims no institution.

## Not yet here

The connections table, the hosted connect flow, signed callbacks and per-bank
accounts arrive in the later SC-1244 PRs.
