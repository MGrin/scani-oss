# @scani/config

Env-validation primitives shared across every app's startup schema. Lives in
its own package so prod-vs-dev gates aren't copy-pasted across
`apps/backend/{api,worker,data-provider}/src/config/env.ts`.

## What's here

| Export | Type | Purpose |
|---|---|---|
| `isProduction` | `boolean` | `process.env.NODE_ENV === 'production'`, captured at module load. |
| `urlSchema` | `z.ZodString` | Any syntactically valid URL. Custom error: `must be a valid URL`. |
| `httpsUrlInProduction` | `z.ZodString \| z.ZodEffects<z.ZodString>` | `urlSchema` plus an `https://` requirement when running in production. |
| `requiredInProd(schema, varName?)` | `z.ZodString \| z.ZodOptional<z.ZodString>` | Wraps a string schema so it's required in prod, optional in dev. The optional `varName` is woven into the error message so missing values name the env var that tripped validation. |

## Usage

```ts
import { httpsUrlInProduction, requiredInProd, urlSchema } from '@scani/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: urlSchema,
  FRONTEND_URL: httpsUrlInProduction,
  ADMIN_JOBS_HMAC_SECRET: requiredInProd(z.string().min(32), 'ADMIN_JOBS_HMAC_SECRET'),
});
```

## When to add to this package

Only env-validation primitives that meaningfully reduce duplication across
multiple apps. One-off shapes used by a single service belong in that
service's `config/env.ts`. If you reach for "I need `httpsUrlInProduction`
but for WebSocket URLs", that goes here. If you reach for "I need to validate
this one Stripe webhook header", that doesn't.

## A note on `isProduction`

The exported `isProduction` constant is captured at module load. The
`httpsUrlInProduction` and `requiredInProd` helpers re-read `NODE_ENV` at
parse / call time, so they remain testable across both branches in a single
process. In a real app this distinction is invisible — `NODE_ENV` doesn't
change after boot.
