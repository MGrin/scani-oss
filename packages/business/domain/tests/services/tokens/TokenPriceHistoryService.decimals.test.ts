import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenPriceEditHistoryRepository } from '../../../src/repositories/TokenPriceEditHistoryRepository';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { TokenPriceHistoryService } from '../../../src/services/tokens/TokenPriceHistoryService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-1116 — a custom token's decimals says who answered it.
 *
 * `decimals_source` exists to say whom to believe when a chain and an import
 * disagree, and `user` is documented in `@scani/db/schema` as the answer for a
 * custom token: there is no chain and no standard for one, so its creator is
 * the only authority there can be.
 *
 * This path wrote the number and left the source NULL, which is
 * indistinguishable from a row predating the column — so a later reader
 * concluding "NULL means nobody ever asked" would be wrong about exactly the
 * case where somebody did. The two sibling creation paths in `TokenService`
 * already attributed; this one did not.
 */

/** What `tokenRepository.create` was handed. */
type CreateArgs = Record<string, unknown>;

function makeService(): { service: TokenPriceHistoryService; created: CreateArgs[] } {
  const created: CreateArgs[] = [];

  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) => ({ id: `type-${code}`, code }),
  } as unknown as TokenTypeRepository);

  Container.set(TokenRepository, {
    findBySymbolAndType: async (_symbol: string, typeId: string) =>
      // The base-currency lookup must resolve; the duplicate check must not.
      typeId === 'type-fiat' ? { id: 'base-token', symbol: 'USD' } : null,
    create: async (args: CreateArgs) => {
      created.push(args);
      return { id: 'created-token', ...args };
    },
  } as unknown as TokenRepository);

  Container.set(TokenPriceRepository, {
    create: async (row: unknown) => row,
  } as unknown as TokenPriceRepository);

  Container.set(TokenPriceEditHistoryRepository, {
    create: async (row: unknown) => row,
  } as unknown as TokenPriceEditHistoryRepository);

  // `withTransaction` reaches the real connection; this service's work is
  // entirely in the stubbed repositories, so run the callback directly rather
  // than making a unit test depend on a live database.
  class TestableService extends TokenPriceHistoryService {
    protected override async withTransaction<T>(callback: (tx: never) => Promise<T>): Promise<T> {
      return callback(undefined as never);
    }
  }

  const service = new TestableService();
  Container.set(TokenPriceHistoryService, service);
  return { service, created };
}

const BASE = {
  symbol: 'zzq',
  name: 'Invented Holdings',
  typeCode: 'private-company',
  manualPrice: 12.5,
  baseCurrencyCode: 'USD',
} as const;

describe('createCustomToken — decimals attribution', () => {
  test("a supplied decimals is attributed to 'user'", async () => {
    const { service, created } = makeService();
    await service.createCustomToken({ ...BASE, decimals: 2 }, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ decimals: 2, decimalsSource: 'user' });
  });

  /**
   * The other half, and the reason `attributeDecimals` is used rather than a
   * literal: a source beside an absent value would claim an authority for an
   * answer nobody gave. Both columns stay NULL together.
   */
  test('an unsupplied decimals leaves BOTH columns null', async () => {
    const { service, created } = makeService();
    await service.createCustomToken({ ...BASE }, 'user-1');

    expect(created[0]).toMatchObject({ decimals: null, decimalsSource: null });
  });

  /**
   * The control. Both assertions above would also pass against a `create` that
   * silently dropped every field it was handed, so at least one unrelated
   * field must arrive for them to be readings of what was written.
   */
  test('the captured create carries the rest of the token, so the assertions are readings', async () => {
    const { service, created } = makeService();
    await service.createCustomToken({ ...BASE, decimals: 2 }, 'user-1');

    expect(created[0]).toMatchObject({
      symbol: 'ZZQ',
      name: 'Invented Holdings',
      typeId: 'type-private-company',
      isActive: true,
    });
  });
});
