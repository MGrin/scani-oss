import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import type { AddValuation, UpdateValuedAssetDetails, ValuedAssetDetails } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { VALUED_ASSET_TYPE_CODES } from '../../lib/custom-token-visibility';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import {
  HandValuedHoldingUseCase,
  NotHandValuedError,
  NothingHeldThenError,
} from '../../use-cases/HandValuedHoldingUseCase';
import { PriceReader } from '../pricing/PriceReader';
import {
  readValuedAsset,
  type ValuedAssetRecord,
  valuedAssetMetadata,
} from './valued-asset-metadata';

interface ValuedAssetValuation {
  on: string;
  value: string;
  recordedAt: string;
  /** A later row on the same day is the value; this one was corrected (Q1). */
  replaced: boolean;
}

export interface ValuedAssetHistory {
  name: string;
  details: ValuedAssetDetails;
  purchase: { on: string; price: string };
  valuations: ValuedAssetValuation[];
  current: string;
  gain: string;
  currencyCode: string;
}

type Holding = typeof schema.holdings.$inferSelect;
type Token = typeof schema.tokens.$inferSelect;

const DAY_MS = 86_400_000;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * A valued asset's valuations and details (SC-1643). A valuation is a manual
 * price on its token, written through `HandValuedHoldingUseCase.updateValue`,
 * so it reaches the cache and the readers the way any hand value does.
 */
@Service()
export class ValuedAssetService {
  private readonly tokens = Container.get(TokenRepository);
  private readonly tokenTypes = Container.get(TokenTypeRepository);
  private readonly prices = Container.get(PriceReader);
  private readonly handValued = Container.get(HandValuedHoldingUseCase);

  /**
   * A correction is a later row on the same day, never an edit (Q1). So the
   * row is stamped one millisecond after the day's latest, and the day's
   * first at its midnight: the latest row in a day wins at every reader.
   */
  async addValuation(
    input: AddValuation,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ holdingId: string }> {
    const run = async (tx: DatabaseTransaction) => {
      const { holding, record } = await this.asset(input.holdingId, userId, tx);
      const midnight = new Date(`${input.occurredOn}T00:00:00Z`);
      // `updateValue` counts units from today's balance back, and so cannot
      // see that nothing was held before the purchase.
      if (
        input.occurredOn < record.purchaseDate ||
        (holding.startsAt && midnight < startOfDay(holding.startsAt))
      )
        throw new NothingHeldThenError();

      const rows = await this.priceRows(holding.tokenId, record.currencyCode, tx, midnight);
      const latest = rows.at(-1)?.timestamp;
      const at = latest ? new Date(latest.getTime() + 1) : midnight;
      await this.handValued.updateValue(
        {
          holdingId: holding.id,
          currencyCode: record.currencyCode,
          occurredAt: at.toISOString(),
          value: input.value,
        },
        userId,
        tx
      );
      return { holdingId: holding.id };
    };
    return transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'valued-asset-valuation', timeout: 15000 });
  }

  async history(
    holdingId: string,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<ValuedAssetHistory> {
    const run = async (t: DatabaseTransaction) => {
      const { token, record } = await this.asset(holdingId, userId, t);
      const rows = await this.priceRows(token.id, record.currencyCode, t);
      const valuations = rows.map((row, i) => ({
        on: dayOf(row.timestamp),
        value: row.price,
        recordedAt: row.timestamp.toISOString(),
        replaced:
          rows[i + 1] !== undefined && dayOf(rows[i + 1]!.timestamp) === dayOf(row.timestamp),
      }));
      const current = rows.at(-1)?.price ?? record.purchasePrice;
      return {
        name: token.name,
        details: record.details,
        purchase: { on: record.purchaseDate, price: record.purchasePrice },
        valuations,
        current,
        gain: new Decimal(current).sub(record.purchasePrice).toFixed(),
        currencyCode: record.currencyCode,
      };
    };
    return tx ? await run(tx) : await withTransaction(run, { name: 'valued-asset-history' });
  }

  async updateDetails(
    input: UpdateValuedAssetDetails,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const run = async (tx: DatabaseTransaction) => {
      const { token, record, kind } = await this.asset(input.holdingId, userId, tx);
      if (input.details.kind !== kind)
        throw new Error(`A ${kind} cannot take ${input.details.kind} details`);
      await tx
        .update(schema.tokens)
        .set({
          ...(input.name ? { name: input.name } : {}),
          providerMetadata: {
            ...((token.providerMetadata as Record<string, unknown> | null) ?? {}),
            ...valuedAssetMetadata({ ...record, details: input.details }),
          },
        })
        .where(eq(schema.tokens.id, token.id));
    };
    if (transaction) await run(transaction);
    else await withTransaction(run, { name: 'valued-asset-details' });
  }

  /** The owner's holding of a valued asset, or not found, as for a wrong id. */
  private async asset(
    holdingId: string,
    userId: string,
    tx: DatabaseTransaction
  ): Promise<{ holding: Holding; token: Token; record: ValuedAssetRecord; kind: string }> {
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)));
    const token = holding ? await this.tokens.findVisibleById(holding.tokenId, userId, tx) : null;
    const type = token ? await this.tokenTypes.findById(token.typeId, tx) : null;
    const record = token ? readValuedAsset(token.providerMetadata) : null;
    if (
      !holding ||
      !token ||
      !type ||
      !record ||
      !(VALUED_ASSET_TYPE_CODES as readonly string[]).includes(type.code)
    )
      throw new NotHandValuedError(holdingId);
    return { holding, token: token as Token, record, kind: type.code };
  }

  /** The token's manual rows in its own currency, oldest first; one day's when `day` is given. */
  private async priceRows(
    tokenId: string,
    currencyCode: string,
    tx: DatabaseTransaction,
    day?: Date
  ): Promise<{ price: string; timestamp: Date }[]> {
    const fiat = await this.tokenTypes.findByCode('fiat', tx);
    const quote = fiat ? await this.tokens.findBySymbolAndType(currencyCode, fiat.id, tx) : null;
    if (!quote) throw new Error(`Currency '${currencyCode}' not found`);
    return this.prices.pairHistory(
      tokenId,
      quote.id,
      day ? { from: day, until: new Date(day.getTime() + DAY_MS) } : undefined,
      tx
    );
  }
}

function startOfDay(at: Date): Date {
  return new Date(`${dayOf(at)}T00:00:00Z`);
}
