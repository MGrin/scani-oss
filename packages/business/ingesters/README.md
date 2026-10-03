# @scani/ingesters

The statement ingester: what a parsed bank statement says, as ledger rows. Leaf package — never imports `@scani/domain`.

Owns:

- `StatementTransactionIngester` — turns a `@scani/file-import` `ParseResult` into the statement's ledger rows, grouped per parsed transaction and keyed by currency, plus the closing balance its last row carries. It names no holding and no token: `legacyStatementBatch` in `@scani/domain` turns the result into a feed batch, and `FeedIngestService` resolves both when it writes it. Owns the dedup-friendly `external_id` synthesis (prefers natural ids like `fitid`/`txid`; falls back to `synthetic:<date>:<amount>:<desc>:<ordinal>`).
- `statementWarnings` — the warnings an import reports once the write path has said which currencies the catalog does not know: the parser's, then one per transaction in file order, then the close's.

## Why a separate package

Tests want to assert the `external_id` synthesis without spinning up the full `@scani/domain` graph, and `@scani/domain` reads the result as a type only (`legacyStatementBatch`). Here the package's tests run without the `reflect-metadata`/`@Service()` ceremony domain tests need.

`StatementTransactionIngester.ingest` takes no callback: it is synchronous and reads nothing but the `ParseResult`.

## Usage (the worker's `file-import` processor)

```ts
import { StatementTransactionIngester, statementWarnings } from '@scani/ingesters';
import Container from 'typedi';

const statement = Container.get(StatementTransactionIngester).ingest({
  accountId,
  parseResult,
  defaultCurrency,
});
const warnings = statementWarnings(statement, unknownCurrencies, ambiguousTickers);
```

## Tests

```bash
bun test packages/business/ingesters --timeout 30000
```

Coverage:

- `StatementTransactionIngester.test.ts` — empty ParseResult, rows keyed by currency, default- and detected-currency fallback, a row with no currency skipped with its warning and its date, signed amount → `kind` mapping (deposit / withdraw), the closing balance, natural vs synthetic external-id synthesis, and the order and count of `statementWarnings`.
