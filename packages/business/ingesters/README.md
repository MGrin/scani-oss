# @scani/ingesters

Transaction-ingester abstractions and the registry that worker processors dispatch through. Leaf package — never imports `@scani/domain`; callers inject the AI screenshot-parser callback and the token-resolver function so this package stays decoupled from domain services.

Owns:

- `TransactionIngester` — interface every ingester implements: a stable `source` string and an `ingestForAccount(accountId, options)` method returning `IngesterResult` (transactions + balance observations + coverage update + soft warnings).
- `TransactionIngesterRegistry` — `@Service()` singleton that the worker bootstraps with a wiring file. Worker processors call `registry.require(source)` to dispatch by `holding_transactions.source` tag.
- `StatementTransactionIngester` — turns a `@scani/file-import` `ParseResult` into normalized `holding_transactions` rows + a closing-balance `holding_balance_observations` anchor. Owns the dedup-friendly `external_id` synthesis (prefers natural ids like `fitid`/`txid`; falls back to `synthetic:<date>:<amount>:<desc>:<ordinal>`).
- `ScreenshotTransactionIngester` — placeholder for AI-parsed bank-statement screenshots. Currently returns an empty result; the parser callback shape (`ScreenshotParserFn`) is finalized so the AI prompt landing later won't churn the public surface.

## Why a separate package

Two pulls toward the same code: (1) the worker's `apps/backend/worker/src/processors/ingest-transactions.ts` dispatches by source; (2) tests want to assert the `external_id` synthesis logic without spinning up the full `@scani/domain` graph. Putting both in `@scani/domain` re-introduces a domain dependency from worker bootstrap. Putting both here lets the worker import `@scani/ingesters` directly and the package's tests run without the `reflect-metadata`/`@Service()` ceremony domain tests need.

The dependency-injection rule that keeps this clean: caller-owned callbacks for everything `@scani/domain` provides.

- `StatementTransactionIngester.ingest({ resolveToken })` — `resolveToken.resolveFiatTokenBySymbol(symbol)` is implemented by the worker (which has access to `TokenService` + `HoldingService`). The ingester only knows it needs a `(symbol) => { holdingId, tokenId } | null` resolver.
- `ScreenshotTransactionIngester` constructor takes a `ScreenshotParserFn` — the worker injects a closure over `Container.get(ScreenshotParsingService).parseScreenshot`.

## Usage (worker bootstrap)

```ts
import { StatementTransactionIngester, TransactionIngesterRegistry } from '@scani/ingesters';
import { ScreenshotParsingService, TokenService } from '@scani/domain/services';
import Container from 'typedi';

const registry = Container.get(TransactionIngesterRegistry);
registry.register(Container.get(StatementTransactionIngester));
registry.register(
  new ScreenshotTransactionIngester((imageBase64, opts) =>
    Container.get(ScreenshotParsingService).parseScreenshot(imageBase64, opts)
  )
);
```

## Tests

```bash
bun test packages/business/ingesters --timeout 30000
```

Coverage:

- `TransactionIngesterRegistry.test.ts` — register / get / require / list, including the duplicate-registration warning and the "no ingester" error path.
- `StatementTransactionIngester.test.ts` — empty ParseResult, currency resolution + caching, unknown-currency warning, default-currency fallback, signed amount → `kind` mapping (deposit / withdraw / unknown), closing-balance observation, natural vs synthetic external-id synthesis, multiple-currencies in one statement.
- `ScreenshotTransactionIngester.test.ts` — smoke test confirming the stub returns the empty-result shape and exposes `source = 'screenshot'`.
