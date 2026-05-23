# @scani/shared

Frontend-safe contract package: zod DTOs + Decimal helper + small UI
formatters and validators. The smallest possible API surface that lets
the React apps and the tRPC backend speak the same language.

**Strict rule**: nothing here may import a Node-only API. Encryption
lives in `@scani/security`; resilience primitives (retry, circuit
breaker) live in `@scani/rate-limiter`; request-scope caching lives in
`@scani/domain/lib/request-cache`. If a future helper needs
`node:crypto` / `node:async_hooks` / `node:fs`, it goes in a different
package.

## What's exported

| Folder | Contents |
|---|---|
| `dtos/` | One file per domain area (account, batch, common, dashboard, group, holding, holdingApy, institution, token, user, vault). Each file exports zod schemas + the inferred TypeScript types they produce. tRPC routers re-validate inputs against these; the React app prop-drills the types. |
| `decimal.ts` | The project-wide-configured `Decimal.js` instance (28-digit precision, HALF_UP rounding) plus `isValidDecimalString` for validating user-supplied decimal strings at file-import / form-input boundaries. |
| `format/currency.ts` | `formatCurrency`, `formatCompact`, `formatNumber`, `formatBytes`, `getCurrencySymbol`. |
| `format/date.ts` | `formatRelative`, `formatIsoDate`, `formatDateTime`, `formatDate`. Lightweight (no `date-fns` / `dayjs`). |
| `validators/` | Canonical zod schemas: `emailSchema`, `urlSchema`, `uuidSchema`, `hexColorSchema`, `requiredString(label)`. Forms and tRPC inputs both reach for these so error messages stay consistent. |

## Usage

### From a React component

```tsx
import { formatCurrency, formatRelative, type HoldingWithDetails } from '@scani/shared';

export function HoldingRow({ item }: { item: HoldingWithDetails }) {
  return (
    <div>
      <span>{formatCurrency(item.value, 'USD')}</span>
      <span>{formatRelative(item.lastUpdated)}</span>
    </div>
  );
}
```

### From a tRPC router input

```ts
import { CreateHoldingDto } from '@scani/shared';

export const holdingsRouter = router({
  create: protectedProcedure
    .input(CreateHoldingDto)        // zod schema, validates at the boundary
    .mutation(async ({ input }) => {
      //                ^ TypeScript narrows from the schema
    }),
});
```

### From a domain service that needs Decimal

```ts
import { Decimal } from '@scani/shared';

const total = new Decimal('123.456').plus('0.001').toString();
```

## Why this package isn't a grab-bag

A previous version of the package included encryption, retry, circuit
breaker, request-scope cache, and an unused `FinancialMath` namespace.
Those four utilities had ~10 dead exports between them and pulled
`node:crypto` / `node:async_hooks` into the frontend's reachable
dependency graph. Splitting them out has these benefits:

- Frontend bundles drop transitive Node-API references.
- Each utility lives next to its real consumer: `@scani/security` (1
  consumer), `@scani/rate-limiter`'s resilience exports (3 consumers),
  `@scani/domain/lib/request-cache` (3 consumers — all in domain).
- Adding a new helper here forces the contributor to ask "is this
  frontend-safe?" — and if not, where it should go instead.

## What does NOT belong here

| Concern | Goes here instead |
|---|---|
| Encryption / secret handling | `@scani/security` |
| Retry / circuit breakers / rate limits | `@scani/rate-limiter` |
| Request-scope memoization | `@scani/domain/lib/request-cache` |
| Domain calculations (PnL, allocation) | `@scani/domain/services/...` |
| DB row types | `@scani/db/schema` |
| Async-job descriptors | `@scani/jobs` |
| BullMQ wire shapes | `@scani/queue` |

## Tests

```
bun test packages/business/shared --timeout 30000
```

Coverage is the DTOs (re-parse known-good and known-bad inputs to lock
the wire contract), the formatters (locale variations + edge cases),
the validators (accept + reject paths), and the `Decimal`
configuration.
