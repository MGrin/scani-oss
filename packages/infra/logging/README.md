# @scani/logging

Pino-based structured logger plus a thin Sentry wrapper used by every
backend service. One canonical configuration so apps don't drift on log
level / pretty-printing / Sentry init.

## Two entry points

| Specifier | Purpose |
|---|---|
| `@scani/logging` | The logger surface. Cheap to import. |
| `@scani/logging/sentry` | Sentry helpers. Imported only by services that ship error reporting (api, worker, data-provider). Frontend / landing apps skip this so `@sentry/node` doesn't end up in their bundle. |

## Logger surface

| Export | Purpose |
|---|---|
| `logger` | Root pino logger. Use directly only at boot, before a component is established. |
| `createComponentLogger(component)` | Returns a child logger with `component` baked in. The default and almost-always-correct way to log. Define one near the top of each module: `const log = createComponentLogger('billing');`. |
| `CustomLogger`, `LogContext` | Types. `CustomLogger` is `pino.Logger` with the two-arg overloads (`log(obj, msg)`) tightened. |
| `logConfig` | The resolved env-driven config (level, pretty, colorize, body-logging flags). Read-only. |
| `sanitizeUrl(url)` | Strips `token` / `api_key` / `secret` / `password` / `authorization` query params before logging. Falls back to a regex when the input isn't a parseable URL. |
| `generateRequestId()` | 20-char base36 random ID. Used for request tracing. |
| `createTimer()` | `{ end: () => ms }`. `process.hrtime`-based, so safe across system clock jumps. |

## Sentry surface

| Export | Purpose |
|---|---|
| `initSentry({ component, release })` | Idempotent boot-time init. No-op when `SENTRY_DSN` is unset. `component` tag distinguishes events from api / worker / data-provider in a shared project. |
| `flushSentry(timeoutMs?)` | Wait for pending events before exit. Called from SIGTERM / shutdown paths. Default 2s. Never throws. |
| `captureException(err, tags?)` | Forward an error. No-op when Sentry isn't initialized. Never throws. |
| `addBreadcrumb({ category, message?, level?, data? })` | Drop a breadcrumb. Used by `@scani/cloud-client` to record data-provider hops so downstream errors carry that context. No-op when not initialized. |

## Usage

```ts
import { createComponentLogger } from '@scani/logging';

const logger = createComponentLogger('billing');

logger.info({ userId, plan: 'pro' }, 'subscription created');
logger.error({ err }, 'failed to charge card');
```

```ts
import { initSentry, flushSentry, captureException } from '@scani/logging/sentry';

initSentry({ component: 'worker', release: process.env.SENTRY_RELEASE });

process.on('SIGTERM', async () => {
  await flushSentry();
  process.exit(0);
});
```

## Pretty mode

Local dev gets human-readable single-line output with emoji + colours:

```
🕒 14:23:01 📝 INFO  [BILLING] {a3f9b2c4} subscription created | userId=u_123 | plan=pro
```

Production gets newline-delimited JSON. Toggle via `LOG_PRETTY=true|false`;
default is auto-on in development, auto-off in production.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `SERVICE_NAME` | `scani` | Goes into every log line's `service` field. Each app's `docker-compose.yml` sets this so a shared log stream can tell `api` / `worker` / `data-provider` rows apart. |
| `SERVICE_VERSION` | `unknown` | Goes into every log line's `version` field. The deploy workflow stages `${GITHUB_SHA}` per Fly app. |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Standard pino levels. |
| `LOG_PRETTY` | auto by `NODE_ENV` | Human-readable single-line vs JSON. |
| `LOG_COLORIZE` | on in dev | ANSI colours in pretty mode. |
| `LOG_TIMESTAMP` | on | Include ISO timestamp in JSON output. |
| `LOG_SQL_QUERIES` | off | Drizzle middleware reads this to enable per-query logging. |
| `LOG_REQUEST_BODIES` / `LOG_RESPONSE_BODIES` | off | Whether `logRequestBodies` / `logResponseBodies` flags are surfaced via `logConfig`. |
| `LOG_WEBSOCKET_MESSAGES` | on | WebSocket frame logging. |
| `SENTRY_DSN` | unset | When set, `initSentry` activates. |
| `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` | inherits from `NODE_ENV` / git SHA | Sentry tags. |
