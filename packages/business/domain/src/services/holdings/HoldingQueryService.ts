import type { DatabaseTransaction } from '@scani/db';
import type { Holding, User } from '@scani/db/schema';
import { type HoldingWithDetails, isManualEditCause } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../../lib/constants';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingApyConfigRepository } from '../../repositories/HoldingApyConfigRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { PortfolioValuationService } from '../portfolio/PortfolioValuationService';

/** A holding hidden from the dashboard, plus why it's hidden. */
interface HiddenHoldingRow {
  id: string;
  balance: string;
  source: string;
  hiddenReason: 'user_hidden' | 'scam' | 'both';
  token: {
    id: string;
    symbol: string;
    name: string;
    iconUrl: string | null;
    isScamProbability: number;
  };
  account: { id: string; name: string };
  institution: { id: string; name: string };
}

// HoldingQueryService — read-only queries against holdings. Mutations
// live in HoldingService; splitting them keeps each class focused on a
// single responsibility (CLAUDE.md / SOLID).
@Service()
export class HoldingQueryService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly holdingApyConfigRepository = Container.get(HoldingApyConfigRepository);
  private readonly holdingCoverageRepository = Container.get(HoldingCoverageRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);
  private readonly portfolioValueDailyRepository = Container.get(PortfolioValueDailyRepository);
  private readonly tokenRepository = Container.get(TokenRepository);

  constructor() {
    super('HoldingQueryService');
  }

  async getHoldingsByAccountIdWithDetails(
    user: User,
    accountId?: string,
    includeHidden = false,
    requestCache?: Map<string, unknown>
  ): Promise<HoldingWithDetails[]> {
    if (!user.baseCurrencyId) {
      throw new Error('User does not have a base currency set');
    }

    this.logger.debug(
      { userId: user.id, accountId, includeHidden },
      'Getting holdings with details'
    );

    const [holdingsWithFullDetails, portfolioValue, costBasisMap] = await Promise.all([
      this.holdingRepository.findByUserWithFullDetails(
        user.id,
        accountId,
        undefined,
        includeHidden
      ),
      this.portfolioValuationService.getUserPortfolioValue(
        user.id,
        user.baseCurrencyId,
        accountId,
        requestCache
      ),
      this.portfolioValueDailyRepository.findLatestHoldingCostBasis(user.id, user.baseCurrencyId),
    ]);

    if (holdingsWithFullDetails.length === 0) {
      return [];
    }

    const holdingIds = holdingsWithFullDetails.map(({ holding }) => holding.id);
    // Same predicate the net-worth chart excludes by (SC-146), asked here so
    // the rows themselves can say which ones were set aside. One indexed query
    // over the tokens already in hand — not per holding.
    const heldTokenIds = [...new Set(holdingsWithFullDetails.map(({ token }) => token.id))];
    const [groupsMap, apyConfigsMap, coverageMap, unpriceableTokenIds] = await Promise.all([
      this.groupRepository.findGroupsForHoldings(
        holdingsWithFullDetails.map(({ holding, account }) => ({
          id: holding.id,
          accountId: account.id,
        }))
      ),
      this.holdingApyConfigRepository.findByHoldingIds(holdingIds),
      this.holdingCoverageRepository.findManyByHoldingIds(holdingIds),
      this.tokenRepository.findNeverPricedInCooldownTokenIds(heldTokenIds, new Date()),
    ]);

    // portfolioPriceMap only contains symbols we could actually price.
    // Skipping null currentPrices here propagates "unpriceable" all the
    // way to the wire so the UI can render "—" instead of "$0".
    const portfolioPriceMap = new Map(
      portfolioValue.holdings.flatMap((h) =>
        h.currentPrice !== null ? [[h.tokenSymbol, h.currentPrice] as const] : []
      )
    );

    // Keyed on the timestamp alone: `source` is nullable in
    // `token_prices`, and dropping the row for a missing source hid the
    // price of a holding we had priced perfectly well.
    const priceMetadataMap = new Map(
      portfolioValue.holdings
        .filter((h) => h.priceTimestamp)
        .map((h) => [
          h.tokenSymbol,
          {
            // Pass null through — the UI distinguishes "no price" from
            // "price = $0" via the nullable field on the wire DTO.
            value: h.currentPrice,
            timestamp: h.priceTimestamp!.toISOString(),
            source: h.priceSource,
          },
        ])
    );

    const detailedHoldings: HoldingWithDetails[] = holdingsWithFullDetails.map(
      ({ holding, token, account, institution }) => {
        const currentPrice = portfolioPriceMap.get(token.symbol);

        // Bounded rounding before .toNumber() (4 dp = 1/100 of a cent).
        // See git history for the previous comment about IEEE-754
        // precision; the only change here is null-propagation when the
        // price isn't resolvable.
        const currentValue =
          currentPrice === undefined
            ? null
            : new Decimal(holding.balance)
                .mul(new Decimal(currentPrice))
                .toDecimalPlaces(4)
                .toNumber();

        // Cost basis comes from the latest portfolio_value_daily
        // holding-scope rollup row (transfer-aware FIFO, in the user's
        // base currency). Falls back to current value — a flat 0 gain —
        // only when the rollup hasn't produced a row for this holding
        // yet, rather than fabricating a number.
        const cachedCostBasis = costBasisMap.get(holding.id);
        const costBasis = cachedCostBasis !== undefined ? cachedCostBasis : currentValue;

        let priceInfo = priceMetadataMap.get(token.symbol);

        if (!priceInfo && token.id === user.baseCurrencyId) {
          priceInfo = {
            value: '1',
            timestamp: new Date().toISOString(),
            source: 'Base Currency',
          };
        }

        const holdingGroups = groupsMap.get(holding.id) || [];
        const apyConfig = apyConfigsMap.get(holding.id);

        const result: HoldingWithDetails = {
          id: holding.id,
          label: holding.label,
          token: {
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            type: token.typeName,
            typeCode: token.typeCode,
            iconUrl: token.iconUrl,
            isScamProbability: token.isScamProbability ?? 0,
            lookalikeOf: token.lookalikeOf ?? null,
          },
          // The balance, whole. `toFixed()` rather than the column verbatim so
          // whatever the row holds is normalised to one canonical decimal
          // string with no exponent — `1e-18` in a cell is text to some
          // readers and a number to none (`@scani/shared/format/precision`).
          //
          // It used to be `.toDecimalPlaces(8).toNumber()`, and both halves
          // lost something. The 8 turned every balance below `1e-8` into `0`,
          // which is not a rounding of a small position but a different claim
          // — that it is empty — repeated by the list, the peek, the CSV and
          // the phone row, and written back to the database by the balance
          // editor. `toNumber()` lost the other end quietly: a double holds
          // ~15-17 significant digits, so `123456789012345.12345678` came
          // across as `123456789012345.12` with nothing said. A string has
          // neither end (SC-567).
          amount: new Decimal(holding.balance).toFixed(),
          value: currentValue,
          costBasis: costBasis,
          price: priceInfo,
          account: {
            id: account.id,
            name: account.name,
            type: account.typeName,
            typeCode: account.typeCode,
            institutionId: account.institutionId,
          },
          institution: {
            id: institution.id,
            name: institution.name,
            type: institution.typeName,
            typeCode: institution.typeCode,
            website: institution.website,
          },
          groups: holdingGroups.map((g) => ({
            id: g.id,
            name: g.name,
            color: g.color,
          })),
          lastUpdated: holding.lastUpdated.toISOString(),
          createdAt: holding.createdAt.toISOString(),
          isActive: holding.isActive,
          isHidden: holding.isHidden,
          source: holding.source,
          // The last answer this holding's owner gave to "what did that edit
          // mean" (SC-510), so the edit control can pre-select it. Null until
          // somebody has answered, and the client must ask when it is null and
          // the token type is ambiguous — the same predicate the API refuses
          // on, so the two cannot disagree about which holdings need asking.
          manualEditCause: isManualEditCause(holding.manualEditCause)
            ? holding.manualEditCause
            : null,
        };

        if (apyConfig) {
          result.apyConfig = {
            id: apyConfig.id,
            annualRatePct: apyConfig.annualRatePct,
            payoutFrequency: apyConfig.payoutFrequency,
            payoutDayOfWeek: apyConfig.payoutDayOfWeek,
            payoutDayOfMonth: apyConfig.payoutDayOfMonth,
            payoutMonth: apyConfig.payoutMonth,
            lastPayoutAt: apyConfig.lastPayoutAt?.toISOString() ?? null,
            isActive: apyConfig.isActive,
          };
        }

        // Surface the reconciliation gap stamped by the import flow:
        // a synthesized negative `opening_balance_quantity` means the
        // ledger doesn't reach back far enough to explain the user's
        // current balance. The chart's `BalanceAtTimeService.clamp`
        // hides this by flooring at zero — the badge tells the user.
        // Only when there is in fact no value to show. A token inside the
        // cooldown that we nonetheless managed to price today is not something
        // the reader needs told about — the number is right there.
        if (currentValue === null && unpriceableTokenIds.has(token.id)) {
          result.unpriceable = true;
        }

        const coverage = coverageMap.get(holding.id);
        if (coverage?.openingBalanceQuantity != null) {
          const opening = new Decimal(coverage.openingBalanceQuantity);
          if (opening.lt(0)) {
            result.dataIntegrity = {
              incompleteHistory: true,
              missingQuantity: opening.toString(),
              ...(coverage.reconciliationNotes ? { note: coverage.reconciliationNotes } : {}),
            };
          }
        }

        return result;
      }
    );

    this.logger.debug(
      { userId: user.id, accountId, count: detailedHoldings.length },
      accountId ? 'Account holdings with details retrieved' : 'Holdings with details retrieved'
    );

    return detailedHoldings;
  }

  async getHoldingsByAccountIdWithSummary(
    user: User,
    accountId?: string,
    includeHidden = false,
    requestCache?: Map<string, unknown>
  ): Promise<{
    holdings: HoldingWithDetails[];
    summary: {
      totalCount: number;
      activeCount: number;
      totalValue: string;
    };
  }> {
    const holdings = await this.getHoldingsByAccountIdWithDetails(
      user,
      accountId,
      includeHidden,
      requestCache
    );

    const activeHoldings = holdings.filter((h) => h.isActive);
    // Sum priceable holdings only — unpriceable ones (h.value === null)
    // contribute nothing rather than coercing to zero, matching the
    // dashboard's totalValue semantics.
    const totalValue = activeHoldings.reduce(
      (sum, h) => (h.value !== null ? sum + h.value : sum),
      0
    );

    return {
      holdings,
      summary: {
        totalCount: holdings.length,
        activeCount: activeHoldings.length,
        totalValue: totalValue.toString(),
      },
    };
  }

  /**
   * Holdings currently invisible on the dashboard — either user-hidden
   * (`isHidden`) or auto-flagged as scam (`token.isScamProbability` over
   * the threshold). Powers the "Hidden Holdings" section of the Tokens
   * page so users can reverse either kind of hiding.
   */
  async getHiddenHoldings(user: User): Promise<HiddenHoldingRow[]> {
    const all = await this.holdingRepository.findByUserWithFullDetails(
      user.id,
      undefined,
      undefined,
      true,
      true
    );

    return all
      .map(({ holding, token, account, institution }) => {
        const isScam = (token.isScamProbability ?? 0) >= SCAM_PROBABILITY_THRESHOLD;
        const isHidden = holding.isHidden;
        if (!isScam && !isHidden) return null;
        const hiddenReason: HiddenHoldingRow['hiddenReason'] =
          isScam && isHidden ? 'both' : isScam ? 'scam' : 'user_hidden';
        return {
          id: holding.id,
          balance: holding.balance,
          source: holding.source,
          hiddenReason,
          token: {
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            iconUrl: token.iconUrl,
            isScamProbability: token.isScamProbability ?? 0,
          },
          account: { id: account.id, name: account.name },
          institution: { id: institution.id, name: institution.name },
        };
      })
      .filter((r): r is HiddenHoldingRow => r !== null);
  }

  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
    includeScamTokens = false
  ): Promise<Holding[]> {
    try {
      return await this.holdingRepository.findByAccount(
        accountId,
        transaction,
        includeHidden,
        includeScamTokens
      );
    } catch (error) {
      throw this.handleError(error, 'findByAccount');
    }
  }

  async getDistinctTokenIds(transaction?: DatabaseTransaction): Promise<string[]> {
    try {
      return await this.holdingRepository.getDistinctTokenIds(transaction);
    } catch (error) {
      throw this.handleError(error, 'getDistinctTokenIds');
    }
  }

  // `findByIdVisible` applies the dashboard's hidden-filter; the
  // unfiltered variant is `findById`.
  async findByIdVisible(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      return await this.holdingRepository.findByIdVisible(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'findByIdVisible');
    }
  }

  async findById(holdingId: string, transaction?: DatabaseTransaction): Promise<Holding | null> {
    try {
      return await this.holdingRepository.findById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }
}
