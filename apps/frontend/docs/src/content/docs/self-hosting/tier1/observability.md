---
title: Observability
description: Structured logs, healthchecks, optional Sentry, and what to scrape if you bring Prometheus.
sidebar:
  order: 9
---

Scani is **observability-friendly without being observability-heavy**.
Structured logs and HTTP healthchecks come out of the box; everything
else is opt-in.

## Structured logs

Every service uses `@scani/logging` (pino). Logs go to stdout as
single-line JSON in production, pretty-printed in dev.

| Env var | Effect |
|---|---|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`. Default `info`. |
| `LOG_PRETTY` | Pretty-print. Default `false` in production. |
| `LOG_SQL_QUERIES` | Log every Drizzle query. Default `false`. Useful for short debug sessions; very chatty otherwise. |
| `LOG_ID_PEPPER` | **Required in production.** 16+ chars. Pepper used to one-way hash user / tenant / account IDs before they appear in logs. Missing pepper is a hard boot failure in prod. |
| `SERVICE_NAME` | Set automatically by compose (`api`, `worker`, `data-provider`). |

The pepper is what makes the logs safe to ship to a centralised log
aggregator. Without it, raw UUIDs would appear in plaintext and
correlation across hosts could re-identify users.

## Collecting logs

Any container-aware log shipper works. Common setups:

- **Loki + Promtail / Grafana Alloy** — Promtail tails the Docker
  log driver and forwards to Loki. Grafana queries Loki.
- **Datadog / New Relic / Honeycomb** — install their agent on the
  host, point it at the Docker socket.
- **`docker compose logs`** — fine for a one-box deploy.

Sample fields you'll see:

```json
{
  "level": "info",
  "time": "2026-05-24T11:00:00.000Z",
  "service": "worker",
  "component": "service:PriceGraphService",
  "msg": "convert",
  "fromToken": "<hashed>",
  "toToken": "<hashed>",
  "path": "one-hop-USD",
  "stale": false
}
```

## Healthchecks

| Service | Endpoint | Status code |
|---|---|---|
| `api` | `GET /health` | `200 {"status":"ok"}` when DB + Redis reachable. |
| `data-provider` | `GET /health` | Same. |
| `frontend-app` | `GET /healthz` | Static `200`. |
| `worker` | _none_ | The worker has no HTTP surface. Liveness is the container being running; readiness is "processed at least one heartbeat job" (visible in BullMQ dashboards). |

The compose file wires these as Docker healthchecks already; your
reverse proxy or load balancer can probe them too.

## Sentry (optional)

Server-side:

| Variable | Effect |
|---|---|
| `SENTRY_DSN` | If unset, the SDK is a no-op and nothing leaves the process. |
| `SENTRY_ENVIRONMENT` | Tag for the release (`production`, `staging`). |
| `SENTRY_RELEASE` | Release identifier; useful to correlate with deployed image tag. |

Browser-side:

| Variable | Effect |
|---|---|
| `VITE_SENTRY_DSN` | Baked into the SPA bundle at build time. |
| `VITE_SENTRY_ENABLED` | `true` to enable. |

Payloads pass through `packages/business/shared/src/utils/sentry-scrubber.ts`
which strips known-credential shapes (`apiKey`, `secret`, `token`,
session cookies, integration credentials) before send. Verify
yourself before pointing at a shared Sentry project.

## Metrics (bring your own)

There is no built-in Prometheus exporter — yet. If you need
metrics:

- **Postgres** — install `postgres_exporter` or use your managed
  provider's metrics surface.
- **Redis** — install `redis_exporter`.
- **BullMQ queue depth + DLQ depth** — the `dlq-depth-probe` and
  `job-heartbeat-probe` scheduled jobs emit warn-level logs when
  they cross thresholds. Convert to metrics via log-based extraction
  if your stack supports it (Loki has `metrics` query type;
  Honeycomb has BubbleUp).
- **API request latencies** — instrument your reverse proxy
  (Caddy and nginx both emit access logs with timing).

If you'd like a built-in Prometheus endpoint, open an issue on
GitHub — it's been discussed and there's no strong reason not to
ship one.

## Tracing

Not built in. The codebase doesn't carry OTLP exporters or
context propagation. The closest thing is correlation IDs in logs
(every request has a `requestId`, every job has a `jobId`).

## What to alert on

Production-grade alerts to consider:

- API `/health` returning non-200 for > 1 minute → service unhealthy.
- DLQ depth > 100 → jobs failing systematically.
- Postgres connection saturation → exhausted pool (often the
  `POSTGRES_POOL_MAX` vs pooler mismatch).
- Disk usage on the `postgres-data` and `minio-data` volumes.
- Sustained job heartbeat misses (the
  [`job-heartbeat-probe`](/reference/jobs/) reports these).
- `unpriceableUntil` cooldowns piling up on many tokens at once →
  an upstream pricing provider has changed shape.

## See also

- [Troubleshooting](/self-hosting/tier1/troubleshooting/)
- [Job catalogue](/reference/jobs/)
- [Production with docker-compose](/self-hosting/tier1/production/)
