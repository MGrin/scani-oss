/**
 * A vault's amount (foundation A3, Task 16): the sum of its holdings' balance
 * × `priceAt(token, vault currency, now)` × the share attached, an unpriced
 * holding left out. A vault reads stored readings and never asks a provider.
 *
 * The vault reads through the global connection, so every row here is
 * committed and removed after each test.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { NewTokenPrice, Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { VaultService } from '../../../src/services/users/VaultService';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { pricingStack } from '../../../test/helpers/pricing-stack';

restoreContainerAfterAll();

const MINUTE = 60 * 1000;

const rows = committedRows();
let fiatTypeId: string;
let usdId: string;

beforeAll(async () => {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  fiatTypeId = fiat.id;
  usdId = await Container.get(PriceHubResolver).usdTokenId();
});

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitPrice(price: NewTokenPrice): Promise<void> {
  await getDb().insert(schema.tokenPrices).values(price);
}

/**
 * A vault in `currency` holding half of a holding of 2 of a fresh crypto
 * token, and the token, committed.
 */
async function commitVault(currency: Token): Promise<{ vaultId: string; token: Token }> {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx, { baseCurrencyId: currency.id });
    rows.users.push(user.id);
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    rows.institutions.push(institution.id);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    rows.tokens.push(token.id);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: '2',
    });
    const [vault] = await tx
      .insert(schema.vaults)
      .values({
        userId: user.id,
        name: 'A vault',
        targetAmount: '1000',
        currencyId: currency.id,
        color: '#3b82f6',
      })
      .returning();
    if (!vault) throw new Error('vault insert failed');
    await tx
      .insert(schema.vaultHoldings)
      .values({ vaultId: vault.id, holdingId: holding.id, percentage: 50 });
    return { vaultId: vault.id, token };
  });
}

/** A fiat of the test's own, one of which buys 2 USD. */
async function commitFiatAtTwoUsd(): Promise<Token> {
  const currency = await getDb().transaction((tx) => makeToken(tx, { typeId: fiatTypeId }));
  rows.tokens.push(currency.id);
  await commitPrice({
    tokenId: currency.id,
    baseTokenId: usdId,
    price: '2',
    timestamp: new Date(Date.now() - MINUTE),
    source: 'frankfurter',
  });
  return currency;
}

async function currentAmount(vaultId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ currentAmount: schema.vaults.currentAmount })
    .from(schema.vaults)
    .where(eq(schema.vaults.id, vaultId));
  return row?.currentAmount;
}

describe('VaultService', () => {
  test('a vault in EUR holding a token priced only in USD is valued through USD', async () => {
    const currency = await commitFiatAtTwoUsd();
    const { vaultId, token } = await commitVault(currency);
    await commitPrice({
      tokenId: token.id,
      baseTokenId: usdId,
      price: '100',
      timestamp: new Date(Date.now() - MINUTE),
      source: 'coingecko',
    });
    const asks = pricingStack();
    const vaults = new VaultService();

    const detail = await vaults.getVaultWithProgress(vaultId);
    await vaults.recalculateVaultAmount(vaultId);

    // 2 × 100 USD = 200 USD = 100 of the vault's currency; half of it is attached.
    expect(detail?.holdings.map((h) => [h.holdingValue, h.attributedValue])).toEqual([
      ['100', '50'],
    ]);
    expect(await currentAmount(vaultId)).toBe('50');
    expect(asks).toEqual([]);
  });

  test('a vault never calls a provider, and an unpriced holding is left out', async () => {
    const currency = await commitFiatAtTwoUsd();
    const { vaultId } = await commitVault(currency);
    const asks = pricingStack();
    const vaults = new VaultService();

    const detail = await vaults.getVaultWithProgress(vaultId);
    await vaults.recalculateVaultAmount(vaultId);

    expect(asks).toEqual([]);
    expect(detail?.holdings.map((h) => [h.holdingValue, h.attributedValue])).toEqual([
      [null, null],
    ]);
    expect(await currentAmount(vaultId)).toBe('0');
  });

  test('CONTROL: a holding in the vault’s own currency counts at 1', async () => {
    const currency = await commitFiatAtTwoUsd();
    const { vaultId } = await commitVault(currency);
    const [vault] = await getDb()
      .select({ id: schema.vaults.id })
      .from(schema.vaults)
      .where(eq(schema.vaults.id, vaultId));
    // The attached holding becomes cash in the vault's currency.
    const [attached] = await getDb()
      .select({ holdingId: schema.vaultHoldings.holdingId })
      .from(schema.vaultHoldings)
      .where(eq(schema.vaultHoldings.vaultId, vault!.id));
    await getDb()
      .update(schema.holdings)
      .set({ tokenId: currency.id })
      .where(eq(schema.holdings.id, attached!.holdingId));
    const vaults = new VaultService();

    await vaults.recalculateVaultAmount(vaultId);

    expect(await currentAmount(vaultId)).toBe('1');
  });
});
