import type { DatabaseTransaction } from '@scani/db';
import type { User } from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import type { CreateValuedAsset } from '@scani/shared';
import Container, { Service } from 'typedi';
import { USER_ENTERED_SOURCE } from '../lib/person-authored-sources';
import { AccountRepository } from '../repositories/AccountRepository';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from '../repositories/EnumRepositories';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { AccountService, InstitutionService } from '../services';
import { valuedAssetMetadata } from '../services/assets/valued-asset-metadata';
import { HoldingCacheWriter } from '../services/feeds/HoldingCacheWriter';
import { TokenPriceHistoryService } from '../services/tokens/TokenPriceHistoryService';
import { CreateHoldingsWithDependenciesUseCase } from './CreateHoldingsWithDependenciesUseCase';
import { HandValuedHoldingUseCase } from './HandValuedHoldingUseCase';

const INSTITUTION_NAME = 'Personal assets';
const ACCOUNT_NAME = { property: 'Property', vehicle: 'Vehicles' } as const;
const SYMBOL_MAX = 20;
/** One purchase per asset holding: the ledger key that keeps a retried create to one row. */
const VALUED_ASSET_PURCHASE_ID = 'valued-asset-purchase';

/**
 * A property or vehicle, valued by hand (SC-1643). It is a custom token whose
 * price per unit is the asset's value, and one holding of one unit opened on
 * the purchase date. So the engine, the rollup and every reader value it the
 * way they value any custom token, and nothing new reaches the calculator.
 */
@Service()
export class CreateValuedAssetUseCase {
  private readonly customTokens = Container.get(TokenPriceHistoryService);
  private readonly tokens = Container.get(TokenRepository);
  private readonly tokenTypes = Container.get(TokenTypeRepository);
  private readonly institutionTypes = Container.get(InstitutionTypeRepository);
  private readonly accountTypes = Container.get(AccountTypeRepository);
  private readonly accounts = Container.get(AccountRepository);
  private readonly institutionService = Container.get(InstitutionService);
  private readonly accountService = Container.get(AccountService);
  private readonly createHoldings = Container.get(CreateHoldingsWithDependenciesUseCase);
  private readonly handValued = Container.get(HandValuedHoldingUseCase);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);

  async execute(
    input: CreateValuedAsset,
    user: User,
    transaction?: DatabaseTransaction
  ): Promise<{ holdingId: string; tokenId: string; fromDay: string }> {
    const run = async (tx: DatabaseTransaction) => {
      const kind = input.details.kind;
      const openedAt = new Date(`${input.purchaseDate}T00:00:00Z`);
      const boughtBefore = input.purchaseDate < new Date().toISOString().slice(0, 10);
      // With no value today the purchase price is the only row, and it holds
      // from the purchase: a second one stamped now would hide every valuation
      // dated before the day the asset was entered (review I2).
      const purchaseOnly = !input.currentValue;

      const token = await this.customTokens.createCustomToken(
        {
          symbol: await this.freeSymbol(input.name, kind, user.id, tx),
          name: input.name,
          typeCode: kind,
          manualPrice: Number(input.currentValue ?? input.purchasePrice),
          baseCurrencyCode: input.currencyCode,
          priceDescription: input.currentValue ? 'Current value' : 'Purchase price',
          ...(purchaseOnly && boughtBefore ? { priceAt: openedAt } : {}),
          decimals: 0,
          metadata: valuedAssetMetadata({
            details: input.details,
            purchaseDate: input.purchaseDate,
            purchasePrice: input.purchasePrice,
            currencyCode: input.currencyCode.toUpperCase(),
          }),
        },
        user.id,
        tx
      );

      const created = await this.createHoldings.execute(
        {
          accountId: await this.accountFor(kind, user.id, tx),
          openedAt: openedAt.toISOString(),
          holdings: [{ tokenId: token.id, balance: '1' }],
        },
        user,
        tx
      );
      const holdingId = created.holdings[0]!.id;

      // Q5 (operator #23634, feeds #23644): the purchase as one buy of the one
      // unit at its price, at the opening instant. The ledger then explains
      // the opening observation — no drift opening, no double count — and the
      // engine's basis is the purchase price, so a gain never reads as 0%.
      const currency = await this.currencyId(input.currencyCode, tx);
      await this.ledger.bulkUpsert(
        [
          {
            userId: user.id,
            holdingId,
            tokenId: token.id,
            kind: 'buy',
            quantity: '1',
            priceNative: input.purchasePrice,
            priceNativeTokenId: currency,
            occurredAt: openedAt,
            source: USER_ENTERED_SOURCE,
            externalId: VALUED_ASSET_PURCHASE_ID,
          },
        ],
        tx
      );
      await this.cacheWriter.apply(user.id, [{ holdingId, balance: '1' }], tx);

      // Bought today, or with the purchase price as the only row, the opening
      // price row above already stands on the day.
      if (boughtBefore && !purchaseOnly) {
        await this.handValued.updateValue(
          {
            holdingId,
            currencyCode: input.currencyCode,
            occurredAt: openedAt.toISOString(),
            value: input.purchasePrice,
          },
          user.id,
          tx
        );
      }

      return { holdingId, tokenId: token.id, fromDay: input.purchaseDate };
    };

    return transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'valued-asset-create', timeout: 15000 });
  }

  private async currencyId(code: string, tx: DatabaseTransaction): Promise<string> {
    const fiat = await this.tokenTypes.findByCode('fiat', tx);
    const token = fiat
      ? await this.tokens.findBySymbolAndType(code.toUpperCase(), fiat.id, tx)
      : null;
    if (!token) throw new Error(`Currency '${code}' not found`);
    return token.id;
  }

  /** The name, as a symbol no other asset of theirs of this kind carries. */
  private async freeSymbol(
    name: string,
    kind: 'property' | 'vehicle',
    userId: string,
    tx: DatabaseTransaction
  ): Promise<string> {
    const type = await this.tokenTypes.findByCode(kind, tx);
    if (!type) throw new Error(`Token type '${kind}' is not seeded`);
    const stem =
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, SYMBOL_MAX) || kind.toUpperCase();
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? '' : String(n);
      const symbol = `${stem.slice(0, SYMBOL_MAX - suffix.length)}${suffix}`;
      if (!(await this.tokens.findOwnedBySymbolAndType(symbol, type.id, userId, tx))) return symbol;
    }
  }

  /** Every property in one account, every vehicle in another, under one institution. */
  private async accountFor(
    kind: 'property' | 'vehicle',
    userId: string,
    tx: DatabaseTransaction
  ): Promise<string> {
    const [institutionType, accountType] = await Promise.all([
      this.institutionTypes.findByCode('other', tx),
      this.accountTypes.findByCode('other', tx),
    ]);
    if (!institutionType || !accountType) throw new Error("The 'other' types are not seeded");
    const { institution } = await this.institutionService.ensureInstitution(
      { name: INSTITUTION_NAME, typeId: institutionType.id },
      userId,
      tx
    );
    const name = ACCOUNT_NAME[kind];
    const existing = await this.accounts.findByUserInstitutionName(
      userId,
      institution.id,
      name,
      tx
    );
    if (existing) return existing.id;
    const account = await this.accountService.createAccount(
      { name, institutionId: institution.id, typeId: accountType.id },
      userId,
      tx
    );
    return account.id;
  }
}
