import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Container } from 'typedi';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from '../../src/repositories/EnumRepositories';
import { withTestDb } from '../../test/helpers/db';

// The enum repos cache aggressively (10-min TTL). The contract that matters
// for correctness: inside a transaction the cache is BYPASSED, so a
// seed-then-read pattern (used by every factory in tests) observes its
// own writes. Pin that.

describe('EnumRepositories', () => {
  test('InstitutionTypeRepository.findByCode hits DB (not cache) inside a transaction', async () => {
    await withTestDb(async (tx) => {
      // Unique code so a previous test-run or cache warm-up can't satisfy the lookup.
      const code = `itype-${randomUUID().slice(0, 8)}`;
      // Without a cache miss, `findByCode` would return null even though
      // we just inserted the row in this tx.
      await tx.insert((await import('@scani/db/schema')).institutionTypes).values({
        code,
        name: 'Temp',
      });
      const repo = Container.get(InstitutionTypeRepository);
      const found = await repo.findByCode(code, tx);
      expect(found?.code).toBe(code);
    });
  });

  test('AccountTypeRepository.findByCode returns null for unknown code', async () => {
    await withTestDb(async (tx) => {
      const repo = Container.get(AccountTypeRepository);
      expect(await repo.findByCode(`atype-${randomUUID().slice(0, 8)}`, tx)).toBeNull();
    });
  });

  test('TokenTypeRepository.findByCodes short-circuits on empty input', async () => {
    await withTestDb(async (tx) => {
      const repo = Container.get(TokenTypeRepository);
      expect(await repo.findByCodes([], tx)).toEqual([]);
    });
  });

  test('TokenTypeRepository.findByCodes resolves multiple codes in one query', async () => {
    await withTestDb(async (tx) => {
      const schema = await import('@scani/db/schema');
      const codeA = `ttype-a-${randomUUID().slice(0, 8)}`;
      const codeB = `ttype-b-${randomUUID().slice(0, 8)}`;
      await tx.insert(schema.tokenTypes).values([
        { code: codeA, name: 'A' },
        { code: codeB, name: 'B' },
      ]);
      const repo = Container.get(TokenTypeRepository);
      const rows = await repo.findByCodes([codeA, codeB], tx);
      expect(rows.map((r) => r.code).sort()).toEqual([codeA, codeB].sort());
    });
  });
});
