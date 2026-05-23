# @scani/domain

Domain logic for Scani: services, use cases, repositories, features, ingesters, and the file-import external services. Consumed by `apps/backend/api`, `apps/backend/worker`, and `apps/backend/data-provider`.

## Layout

```
packages/business/domain/
├── src/
│   ├── services/             stateless orchestrators (@Service(), class-field DI)
│   ├── use-cases/            application workflows triggered by jobs or HTTP
│   ├── repositories/         data access; extend BaseRepository
│   ├── features/             tRPC-shaped feature implementations (1400-LOC barrel + impl/*.ts)
│   ├── ingesters/            TransactionIngester registry + per-source ingesters
│   ├── external-services/    file-import (CSV / OFX / QIF / format-detector)
│   ├── lib/                  shared helpers (request-cache, price-map)
│   └── config/               shared domain-config constants
├── tests/                    mirrored test layout — `tests/<dir>/X.test.ts` pairs with `src/<dir>/X.ts`
└── test/helpers/             db, factories, fixtures used by all tests
```

## Services vs. use cases

- **Services** are stateless orchestrators that compose repositories + other services + `@scani/providers`. They are the "what" — caching, validation, federation, business invariants.
- **Use cases** are the application workflows: each one is the entry point for a single triggered intent (a job processor, a tRPC mutation, an HTTP endpoint). They orchestrate services + repositories to fulfill that intent.

A use case typically owns a transaction boundary; a service typically does not (it accepts an optional `transaction` parameter and joins the caller's transaction when supplied).

## Services vs. providers

- `@scani/domain` services own the "what": which provider to call, how long to cache, how to fall back, what counts as a scam token, etc.
- `@scani/providers` owns the "how": HTTP fetching, request signing, response parsing, rate-limiting per upstream.

When adding a new pricing source, the HTTP client goes in `@scani/providers/<provider-name>/`; the policy decision (when to call it, cache TTL, fallback chain) goes in `@scani/domain/services/`.

## Dependency injection — class-field, not constructor

Every `@Service()`-decorated class **must** use class-field DI:

```ts
@Service()
export class MyService extends BaseService {
  private readonly repo = Container.get(MyRepository);
  private readonly other = Container.get(OtherService);

  constructor() {
    super('MyService');
  }
}
```

Constructor-param injection (`constructor(private readonly repo: MyRepository)`) silently breaks under Bun: the TS transpiler doesn't emit `design:paramtypes`, so typedi falls back to injecting its own `ContainerInstance` into every slot. Tests pass (they `new Service(stub)` directly), production breaks. See CLAUDE.md → "Dependency Injection (typedi)" for the full rationale.

## Testing

- Runner: `bun test`. No Jest, no Vitest.
- Layout: `tests/<dir>/X.test.ts` mirrors `src/<dir>/X.ts`. New tests must use this layout.
- Preload: `test-preload.ts` loads `reflect-metadata` and a default `DATABASE_URL` pointed at the docker-compose Postgres on `localhost:5433`.
- Per-test isolation: repository tests wrap in `withTestDb` from `test/helpers/db` and roll back on exit.
- Stubbed-DI pattern: `Container.set(Dep, stub); new Service();`. Never `Container.reset()` (it wipes the `@Service()` registration). Reference: `tests/services/BalanceAtTimeService.test.ts`.

```bash
# from the repo root
bun test --preload ./packages/business/domain/test-preload.ts packages/business/domain --timeout 30000
```

## Common patterns

- **Read deduplication**: when several services in the same tRPC batch hit `PortfolioValuationService.getUserPortfolioValue`, pass `requestCache` from the tRPC context — `lib/request-cache.ts` collapses duplicate calls inside one HTTP request.
- **Price-map extraction**: `lib/price-map.ts` exposes `extractPriceMap(portfolioValue)` so `AccountService` / `DashboardService` / `AssetAllocationService` don't reimplement the same `balance × price` walk.
- **Holding mutations vs reads**: mutations live in `HoldingService`, reads in `HoldingQueryService`. Use the right one — mutating from the query service or vice versa is a code smell.

## Type-check

```bash
cd packages/business/domain && bun run type-check
```

The script runs `tsgo --noEmit` (`@typescript/native-preview`) — dramatically faster than `tsc` on this monorepo.
