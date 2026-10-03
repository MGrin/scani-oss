import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { DatabaseTransaction as ServiceTransaction } from '@scani/db/transaction';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { restoreContainerAfterAll } from '../../../test/helpers';
import { withTestDb } from '../../../test/helpers/db';

/**
 * SC-1510. An SPL token's identity is its mint, and the symbol is whatever the
 * mint's creator typed. Resolving by `(symbol, type)` alone put a scam `SOL`
 * mint on the native SOL row, so a new user adding a Solana wallet holding it
 * saw a phantom $1.07B priced as real SOL (worker C, SC-1519 finding 1, wallet
 * 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM). Against a real database,
 * because the lookups are SQL.
 */

restoreContainerAfterAll();
Container.set(ProviderRegistry, { getIdentityEnrichers: () => [] } as unknown as ProviderRegistry);

const SCAM_SOL_MINT = 'Sc1510ScamSo1MintxxxxxxxxxxxxxxxxxxxxxxxxxA';
const REAL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOOKALIKE_USDC_MINT = 'Sc1510LookalikeUsdcMintxxxxxxxxxxxxxxxxxxxB';

async function cryptoTypeId(tx: DatabaseTransaction): Promise<string> {
  const [row] = await tx
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'crypto'))
    .limit(1);
  if (row) return row.id;
  const [created] = await tx
    .insert(schema.tokenTypes)
    .values({ code: 'crypto', name: 'crypto' })
    .returning();
  if (!created) throw new Error('could not create the crypto token type');
  return created.id;
}

// `withTestDb` hands out `@scani/db`'s wider transaction type; the service
// takes `@scani/db/transaction`'s. Both are the same live transaction.
function resolve(
  partial: Parameters<TokenIdentityService['findOrCreateByIdentity']>[0],
  tx: DatabaseTransaction
) {
  return Container.get(TokenIdentityService).findOrCreateByIdentity(
    partial,
    tx as ServiceTransaction
  );
}

function spl(symbol: string, mint: string, typeId: string) {
  return {
    symbol,
    name: symbol,
    decimals: 6,
    typeId,
    providerMetadata: { solana: { mint } },
  };
}

describe('TokenIdentityService — an SPL token is its mint (SC-1510)', () => {
  test('a scam mint calling itself SOL does not land on native SOL', async () => {
    await withTestDb(async (tx) => {
      const typeId = await cryptoTypeId(tx);
      const native = await resolve(
        { symbol: 'SOL', name: 'Solana', decimals: 9, typeId, providerMetadata: {} },
        tx
      );
      const scam = await resolve(spl('SOL', SCAM_SOL_MINT, typeId), tx);
      expect(scam.id).not.toBe(native.id);
      expect(scam.marketSegment).toBe(`solana:${SCAM_SOL_MINT}`);
      expect(native.marketSegment).toBeNull();
    });
  });

  test('two mints sharing a symbol are two tokens, and one mint is always one', async () => {
    await withTestDb(async (tx) => {
      const typeId = await cryptoTypeId(tx);
      const real = await resolve(spl('USDC', REAL_USDC_MINT, typeId), tx);
      const fake = await resolve(spl('USDC', LOOKALIKE_USDC_MINT, typeId), tx);
      expect(fake.id).not.toBe(real.id);

      const again = await resolve(spl('USDC', REAL_USDC_MINT, typeId), tx);
      expect(again.id).toBe(real.id);
    });
  });

  test('a mint seen again under a new symbol resolves to the row it already has', async () => {
    // Jupiter renames, and a mint first seen with no Jupiter record arrives
    // under the mint-prefix fallback symbol. The mint is the identity.
    await withTestDb(async (tx) => {
      const typeId = await cryptoTypeId(tx);
      const mint = 'Sc1510RenamedMintxxxxxxxxxxxxxxxxxxxxxxxxxC';
      const first = await resolve(spl(mint.slice(0, 8).toUpperCase(), mint, typeId), tx);
      const renamed = await resolve(spl('RNMD', mint, typeId), tx);
      expect(renamed.id).toBe(first.id);
    });
  });

  test('a mint is matched case-sensitively, because base58 carries case', async () => {
    await withTestDb(async (tx) => {
      const typeId = await cryptoTypeId(tx);
      const mint = 'Sc1510CaseMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxD';
      const upper = await resolve(spl('CASE', mint, typeId), tx);
      const lower = await resolve(spl('CASE', mint.toLowerCase(), typeId), tx);
      expect(lower.id).not.toBe(upper.id);
    });
  });

  test('control: native SOL from two providers is still one token', async () => {
    // Green before the fix as well, which is what makes it a control: the mint
    // rule must leave mint-less identities on the symbol path.
    await withTestDb(async (tx) => {
      const typeId = await cryptoTypeId(tx);
      const native = { symbol: 'SOL', name: 'Solana', decimals: 9, typeId, providerMetadata: {} };
      const first = await resolve(native, tx);
      const second = await resolve({ ...native, name: 'SOL' }, tx);
      expect(second.id).toBe(first.id);
    });
  });
});
