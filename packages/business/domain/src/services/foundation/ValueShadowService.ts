import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { PortfolioValuationService } from '../portfolio/PortfolioValuationService';
import { type ShadowRunResult, ShadowRunService, type ShadowTally } from './ShadowRunService';
import { compareValue } from './value-comparison';

export interface ValueShadowInput {
  /** The instant the live valuation is taken at. */
  asOf: Date;
  userId?: string;
}

/**
 * The nightly value shadow (SC-1610): every holding the live valuation lists,
 * its cached `value_base` beside `PortfolioValuationService` at `asOf`, both
 * read in the user's snapshot. It writes only its report.
 */
@Service()
export class ValueShadowService {
  private readonly runs = Container.get(ShadowRunService);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly valuation = Container.get(PortfolioValuationService);

  run(input: ValueShadowInput, tx?: DatabaseTransaction): Promise<ShadowRunResult> {
    return this.runs.run(
      {
        kind: 'value',
        asOf: input.asOf,
        userId: input.userId,
        units: async (setupTx) =>
          (await this.evidence.findUsersWithHoldings(setupTx))
            .filter((u) => u.baseCurrencyId !== null)
            .filter((u) => input.userId === undefined || u.userId === input.userId)
            .map((u) => ({ userId: u.userId, baseTokenId: u.baseCurrencyId as string })),
        describe: (unit) => `user ${unit.userId}`,
        compare: (unit, userTx) => this.compareUser(unit, input.asOf, userTx),
      },
      tx
    );
  }

  private async compareUser(
    unit: { userId: string; baseTokenId: string },
    asOf: Date,
    tx: DatabaseTransaction
  ): Promise<ShadowTally> {
    const live = await this.valuation.computePortfolioValueAt(unit.userId, { at: asOf, tx });
    const cached = new Map(
      (
        await tx
          .select({
            id: schema.holdings.id,
            value: schema.holdings.valueBase,
            pricedAt: schema.holdings.valuePricedAt,
          })
          .from(schema.holdings)
          .where(eq(schema.holdings.userId, unit.userId))
      ).map((row) => [row.id, row])
    );

    const tally: ShadowTally = { compared: 0, differences: [] };
    for (const holding of live.holdings) {
      tally.compared += 1;
      const cache = cached.get(holding.holdingId);
      const difference = compareValue(
        { value: cache?.value ?? null, pricedAt: cache?.pricedAt ?? null },
        {
          value: holding.value,
          readingAt: holding.priceTimestamp ?? null,
          price: holding.currentPrice,
          balance: holding.balance,
          isBase: holding.tokenId === unit.baseTokenId,
        },
        asOf
      );
      if (difference === null) continue;
      tally.differences.push({
        ...difference,
        userId: unit.userId,
        holdingId: holding.holdingId,
        tokenId: holding.tokenId,
        baseTokenId: unit.baseTokenId,
      });
    }
    return tally;
  }
}
