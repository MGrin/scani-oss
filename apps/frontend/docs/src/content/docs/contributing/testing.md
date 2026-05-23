---
title: Testing patterns
description: Bun test, the shared preload, withTestDb transaction-per-test, and the stubbed-DI pattern.
sidebar:
  order: 4
---

## Runner

`bun test`. No Jest, no Vitest.

## Layout

Tests live in **`tests/` mirroring `src/`**:

```
packages/business/domain/
  src/
    services/
      HoldingService.ts
  tests/
    services/
      HoldingService.test.ts
```

New tests must use this layout. Existing inline `*.test.ts` files
next to source should migrate to the mirrored layout when the
surrounding code is touched.

## The shared preload

`packages/business/domain/test-preload.ts` is loaded by every test
run:

- `import 'reflect-metadata'` — required for the typedi
  `@Service()` decorator to work.
- Sets a default `DATABASE_URL` pointed at the docker-compose
  Postgres (`localhost:5433`).

Run tests with:

```sh
bun test --preload ./packages/business/domain/test-preload.ts \
  packages/ --timeout 30000
```

CI uses the same preload globally.

## Per-test transaction isolation

Repository tests use `withTestDb` (in
`packages/business/domain/test/helpers/db.ts`) to wrap each test
body in a Postgres transaction that is rolled back on exit:

```ts
import { withTestDb } from '../helpers/db';

test('HoldingRepository.create writes a row', async () => {
  await withTestDb(async (tx) => {
    const repo = new HoldingRepository();
    const result = await repo.create(tx, { ... });
    expect(result).toBeDefined();
  });
  // tx rolled back here — no state leaks to the next test
});
```

This means suites can run in parallel against the same database
without interfering. Stable, fast, no per-test schema cleanup.

## Stubbed-DI pattern

For services with class-field DI (see
[DI pattern](/contributing/di-pattern/)):

```ts
import { Container } from 'typedi';
import { MyService } from '../../src/services/MyService';
import { MyRepository } from '../../src/repositories/MyRepository';

function makeService(stubRepo: Partial<MyRepository> = {}): MyService {
  Container.set(MyRepository, stubRepo as MyRepository);
  const instance = new MyService();
  Container.set(MyService, instance);
  return instance;
}

test('MyService.do() returns whatever the repo gave', async () => {
  const service = makeService({
    findById: async () => ({ id: '123', name: 'mock' }),
  });

  const result = await service.do('123');
  expect(result.name).toBe('mock');
});
```

Don't `Container.reset()` between tests — it wipes the
`@Service()` registration of every service in the container.

## Test isolation across files

Bun runs tests in parallel across files. The `withTestDb`
transaction-per-test pattern keeps repository tests isolated; the
container is process-wide, but each test file imports its own
service and its own stubs, and the `Container.set(...)` calls in
one file don't materialise across files unless they share the
service class. In practice the container's "last-write-wins"
semantic is fine because no two files in the same process race for
the same class.

## What not to do

- **Don't mock the database.** Use `withTestDb` against the real
  schema. Mocks drift; the migration suite catches real schema
  changes before they ship.
- **Don't call `Container.reset()`** between tests. Wipes the
  registry; subsequent `Container.get(...)` of any service throws.
- **Don't `new` services without the registration step.** Class-field
  initialisers will pull whatever's in the container *now*, which
  may be a stale stub from a previous test.
- **Don't share test fixtures across files via module-level
  state.** Bun reuses workers; module-level mutable state surprises
  across runs.

## Coverage

`bun test --coverage` runs on demand per package. Not run in CI.
Useful for finding gaps; not a gating signal.

## See also

- [Engineering conventions](/contributing/conventions/)
- [Dependency injection pattern](/contributing/di-pattern/)
- The canonical spec:
  [`CLAUDE.md` — Testing section](https://github.com/MGrin/scani-oss/blob/main/CLAUDE.md#testing)
