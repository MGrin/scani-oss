# @scani/file-import

Bank-statement parsing primitives. Pure functions; no DI, no DB, no `@scani/domain` import — keeps the dependency graph one-way and lets the tRPC router + the worker's `ParseFileUseCase` pull from the same source.

Owns:

- `parseStatement(content, filename?, opts?)` — unified entry point. Detects the format from filename + content sniffing and dispatches to the right per-format parser. Returns `ParseResult` with transactions, extracted holdings, the resolved format, and any warnings.
- `parseCsvStatement(content, bankTemplate?, customMapping?)` — column-mapped CSV parser. Built-in templates for Revolut / Tinkoff / Sberbank / Wise / Monzo; falls back to AI column detection when the caller injects an `aiColumnDetector` (see below).
- `parseIbCsvStatement(content)` — Interactive Brokers' multi-section CSV; treated as its own format because the row shape differs.
- `parseOfxStatement(content)` — OFX / QFX (Open Financial Exchange).
- `parseQifStatement(content)` — Quicken Interchange Format.
- `detectFormat(content, filename?)` — `csv | ib-csv | ofx | qif | pdf | mt940 | null`.
- `detectBankTemplate(headers)` — returns `'revolut' | 'tinkoff' | 'sberbank' | 'wise' | 'monzo' | null` from CSV column headers.
- `extractHoldingsFromTransactions(transactions, fallbackCurrency?)` — derives final per-currency holdings (last seen running balance per currency).
- `BANK_TEMPLATES` — per-bank column-mapping configs.

## AI column detection — caller-injected callback

For CSV files where built-in templates and the heuristic auto-detector miss the balance/credit/date columns, `parseStatement` can fall back to an AI column-detector. To keep this package leaf-free of `@scani/domain`, the AI hook is passed in:

```ts
import { parseStatement } from '@scani/file-import';
import { CsvColumnDetectionService } from '@scani/domain/services';

const result = await parseStatement(content, filename, {
  bankTemplate,
  customMapping,
  aiColumnDetector: (headers, sampleRows) =>
    Container.get(CsvColumnDetectionService).detectColumns(headers, sampleRows),
});
```

If the callback isn't provided, the parser sticks with whatever the heuristic detector found (or returns warnings).

## Why a separate package

Three properties matter: (1) the parsers are pure functions, no DI; (2) they're consumed by both the api router (synchronous CSV preview) and the worker (`ParseFileUseCase`) — keeping them in `@scani/domain` would re-introduce a domain import from the api router for "just parse this CSV". (3) Dependency injection of the AI column-detector means this package never references `@scani/domain`, so the dependency graph stays one-way.

The two consumers are:

- `apps/backend/api/src/presentation/routers/file-import.ts` — the tRPC route that previews a file before the user confirms upload.
- `packages/business/domain/src/use-cases/ParseFileUseCase.ts` — the use-case the worker runs.

Both call `parseStatement` and wire the AI callback through `Container.get(CsvColumnDetectionService)`.

## Tests

```bash
bun test packages/business/file-import --timeout 30000
```

Coverage:

- `format-detector.test.ts` — extension + content sniffing + bank-template header matching.
- `csv-parser.test.ts` — built-in templates + custom mapping + edge cases (empty rows, signed amounts, currency column).
- `ib-csv-parser.test.ts` — IB-specific multi-section parsing.
- `ofx-parser.test.ts` — OFX bank-statement + credit-card statement paths.
- `qif-parser.test.ts` — QIF record parsing + ambiguous date heuristics.
- `index.test.ts` — `parseStatement` dispatch + AI-callback wiring.
