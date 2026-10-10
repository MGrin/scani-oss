import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import type { MoveHandValuedMoneyInput, UpdateHandValueInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { CUSTOM_TOKEN_TYPE_CODES } from '../lib/custom-token-visibility';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { TokenPriceEditHistoryRepository } from '../repositories/TokenPriceEditHistoryRepository';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingCacheWriter } from '../services/feeds/HoldingCacheWriter';
import { manualEditFlowLeg } from '../services/holdings/ManualBalanceEditService';
import { PriceWriter } from '../services/pricing/PriceWriter';
import { MovementExceedsBalanceError } from './RecordHoldingMovementUseCase';
import { UpdateHoldingUseCase } from './UpdateHoldingUseCase';

/** Not the owner's holding, or its token's price comes from a market. */
export class NotHandValuedError extends Error {
  constructor(readonly holdingId: string) {
    super('Only a hand-valued holding of yours can be edited in money');
    this.name = 'NotHandValuedError';
  }
}

/** Nothing was held on the day a value was given for. */
export class NothingHeldThenError extends Error {
  constructor() {
    super('Nothing was held on that date, so it has no value to set');
    this.name = 'NothingHeldThenError';
  }
}

/** Money dated before the first value has no price to turn into units. */
export class NoPriceYetError extends Error {
  constructor() {
    super('Set a value on or before this date first');
    this.name = 'NoPriceYetError';
  }
}

const UNIT_SCALE = 18;
/** An upper bound no ledger row reaches, and one Postgres can parse — `new Date(8.64e15)` serializes as year +275760, which it cannot. */
const END_OF_TIME = new Date('9999-12-31T23:59:59Z');

type Holding = typeof schema.holdings.$inferSelect;

/**
 * A hand-valued holding, edited in money (SC-1596).
 *
 * SC-1590 keeps such a holding as units of a custom token priced by hand, which
 * is what lets growth and money moved be told apart. The owner reads neither a
 * unit count nor a price per unit off a fund statement, so both are derived
 * here: a new value sets that day's price per unit, and money in or out buys
 * or sells units at the price standing on that day.
 *
 * Qualifies: a holding of the caller's whose token is a custom type they can
 * see — the same rule that lets them edit its price per unit by hand.
 */
@Service()
export class HandValuedHoldingUseCase {
  private readonly tokens = Container.get(TokenRepository);
  private readonly tokenTypes = Container.get(TokenTypeRepository);
  private readonly prices = Container.get(TokenPriceRepository);
  private readonly priceHistory = Container.get(TokenPriceEditHistoryRepository);
  private readonly priceWriter = Container.get(PriceWriter);
  private readonly valueCache = Container.get(HoldingCacheWriter);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly updateHolding = Container.get(UpdateHoldingUseCase);

  /** Growth: the value moves, the units do not. */
  async updateValue(
    input: UpdateHandValueInput,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ holdingId: string; price: string }> {
    const run = async (tx: DatabaseTransaction) => {
      const holding = await this.handValuedHolding(input.holdingId, userId, tx);
      const quote = await this.currency(input.currencyCode, tx);
      const at = new Date(input.occurredAt);

      // Units held THEN: today's balance less every row dated after it.
      const after = await this.ledger.sumQuantityInRange(holding.id, at, END_OF_TIME, tx);
      const units = new Decimal(holding.balance).sub(after);
      // Not `isPositive()`: decimal.js answers true for zero.
      if (units.lte(0)) throw new NothingHeldThenError();

      const price = new Decimal(input.value).div(units).toDecimalPlaces(UNIT_SCALE).toFixed();
      const [previous] = await this.prices.findLatestPricesAtOrBefore(
        [{ tokenId: holding.tokenId, baseTokenId: quote, at, granularity: 'intraday' }],
        tx
      );
      const { changed } = await this.priceWriter.writeManual(
        {
          tokenId: holding.tokenId,
          baseTokenId: quote,
          price,
          at,
          granularity: 'intraday',
          source: 'manual',
        },
        tx
      );
      await this.valueCache.revalueAffected(changed, new Date(), { tx });
      await this.priceHistory.create(
        {
          tokenId: holding.tokenId,
          baseTokenId: quote,
          previousPrice: previous ?? null,
          newPrice: price,
          editedByUserId: userId,
          reason: `Value set to ${input.value} ${input.currencyCode.toUpperCase()}`,
        },
        tx
      );
      return { holdingId: holding.id, price };
    };

    return transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'hand-valued-update', timeout: 15000 });
  }

  /** A flow: units bought or sold at the price standing that day. */
  async moveMoney(
    input: MoveHandValuedMoneyInput,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ holdingId: string; balance: string }> {
    const run = async (tx: DatabaseTransaction) => {
      const holding = await this.handValuedHolding(input.holdingId, userId, tx);
      const quote = await this.currency(input.currencyCode, tx);
      const occurredAt = new Date(input.occurredAt);

      const [price] = await this.prices.findLatestPricesAtOrBefore(
        [{ tokenId: holding.tokenId, baseTokenId: quote, at: occurredAt, granularity: 'intraday' }],
        tx
      );
      if (!price || new Decimal(price).lte(0)) throw new NoPriceYetError();

      const units = new Decimal(input.amount).div(price).toDecimalPlaces(UNIT_SCALE);
      const delta = input.direction === 'in' ? units : units.neg();
      const balance = new Decimal(holding.balance).add(delta);
      if (balance.isNegative())
        throw new MovementExceedsBalanceError(holding.balance, units.toFixed());

      const editedAt = new Date();
      const updated = await this.updateHolding.execute(
        holding.id,
        {
          balance: balance.toFixed(),
          editCause: 'flow',
          editOccurredAt: occurredAt,
          editedAt,
          // Money out of a fund leaves it; where it lands is the owner's
          // other holding's business, recorded there when it arrives.
          ...(input.direction === 'out' ? { editOutflow: { decision: 'left_control' } } : {}),
        },
        userId,
        tx
      );

      // The flow is worth what was typed. Without a price on the row, basis and
      // Returns would value it at whatever price stands on its day — and a
      // value entered later for an earlier day would silently re-price it.
      const leg = manualEditFlowLeg(holding.id, editedAt);
      await tx
        .update(schema.holdingTransactions)
        .set({ priceNative: price, priceNativeTokenId: quote })
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, leg.holdingId),
            eq(schema.holdingTransactions.source, leg.source),
            eq(schema.holdingTransactions.externalId, leg.externalId)
          )
        );

      return { holdingId: holding.id, balance: updated.balance };
    };

    return transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'hand-valued-money', timeout: 15000 });
  }

  private async handValuedHolding(
    holdingId: string,
    userId: string,
    tx: DatabaseTransaction
  ): Promise<Holding> {
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.id, holdingId),
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.isHidden, false)
        )
      );
    if (!holding) throw new NotHandValuedError(holdingId);
    const token = await this.tokens.findVisibleById(holding.tokenId, userId, tx);
    const type = token ? await this.tokenTypes.findById(token.typeId, tx) : null;
    if (!type || !(CUSTOM_TOKEN_TYPE_CODES as readonly string[]).includes(type.code))
      throw new NotHandValuedError(holdingId);
    return holding;
  }

  private async currency(code: string, tx: DatabaseTransaction): Promise<string> {
    const fiat = await this.tokenTypes.findByCode('fiat', tx);
    const token = fiat
      ? await this.tokens.findBySymbolAndType(code.toUpperCase(), fiat.id, tx)
      : null;
    if (!token) throw new Error(`Currency '${code}' not found`);
    return token.id;
  }
}
