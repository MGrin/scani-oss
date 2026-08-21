/**
 * Writes the dataset `buildDemoDataset()` describes into a database.
 *
 * **Idempotent, and idempotent in a specific way**: it deletes the demo user
 * first and lets the cascade take everything hanging off them, then rewrites
 * the lot. Re-running therefore rebuilds rather than accumulating, which is
 * what makes "reset the demo" a single command SC-467 can put on a schedule.
 *
 * Two catalogs are shared with every other user in the database and are
 * treated as read-mostly:
 *
 * - **`institutions`** — looked up by name, inserted only when genuinely
 *   absent. Every institution the persona uses already ships in migration
 *   `0000_clean_start.sql`, so on a migrated database this inserts nothing. A
 *   demo that forked the catalog would leave a second "Kraken" behind for
 *   everyone.
 * - **`tokens`** — fiat comes from the same migration and is never written.
 *   The eight crypto/equity rows are created if missing on the identity tuple
 *   the database is unique on, `(symbol, type_id, COALESCE(market_segment,
 *   ''))`.
 *
 * `token_prices` is the exception: those rows are global, nothing cascades
 * them, and leaving an old anchor's series behind would put two overlapping
 * price histories in front of the valuation code. They carry
 * `source = 'demo-dataset'` and every one of them is deleted before the new
 * series is written.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { type BuildDemoDatasetOptions, buildDemoDataset, type DemoDataset } from './dataset';

const logger = createComponentLogger('demo-dataset-seeder');

/** Tags every price row this seeder writes, so it can take them back. */
export const DEMO_PRICE_SOURCE = 'demo-dataset';

const CHUNK = 1000;

async function insertChunked<T>(rows: readonly T[], write: (batch: T[]) => Promise<void>) {
  for (let index = 0; index < rows.length; index += CHUNK) {
    await write(rows.slice(index, index + CHUNK) as T[]);
  }
}

export interface DemoSeedSummary {
  readonly userId: string;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly counts: Record<string, number>;
}

@Service()
export class DemoDatasetSeeder {
  async seed(options: BuildDemoDatasetOptions = {}): Promise<DemoSeedSummary> {
    const dataset = buildDemoDataset(options);
    return this.write(dataset);
  }

  async write(dataset: DemoDataset): Promise<DemoSeedSummary> {
    const tokenTypes = await this.codeMap(schema.tokenTypes);
    const accountTypes = await this.codeMap(schema.accountTypes);
    const institutionTypes = await this.codeMap(schema.institutionTypes);

    const tokenIds = new Map<string, string>();
    for (const symbol of ['GBP', 'USD', 'EUR']) {
      tokenIds.set(symbol, await this.fiatTokenId(symbol, tokenTypes));
    }
    for (const token of dataset.tokens) {
      tokenIds.set(
        token.symbol,
        await this.ensureToken(token, tokenTypes.get(token.typeCode) as string)
      );
    }

    const institutionIds = new Map<string, string>();
    for (const institution of dataset.institutions) {
      institutionIds.set(
        institution.name,
        await this.ensureInstitution(
          institution.name,
          institutionTypes.get(institution.typeCode) as string
        )
      );
    }

    // Wipe first: the user cascade takes accounts, holdings, transactions,
    // observations, rollups, groups, vaults, vendors, payments and documents
    // with it, and the price rows are reclaimed by their source tag.
    await db.delete(schema.users).where(eq(schema.users.email, dataset.user.email));
    await db.delete(schema.tokenPrices).where(eq(schema.tokenPrices.source, DEMO_PRICE_SOURCE));

    await db.insert(schema.users).values({
      id: dataset.user.id,
      email: dataset.user.email,
      name: dataset.user.name,
      emailVerified: true,
      timezone: dataset.user.timezone,
      baseCurrencyId: tokenIds.get(dataset.user.baseCurrency) as string,
      costBasisMethod: dataset.user.costBasisMethod,
      createdAt: dataset.user.createdAt,
      updatedAt: dataset.user.createdAt,
    });

    await insertChunked(dataset.prices, async (batch) => {
      await db
        .insert(schema.tokenPrices)
        .values(
          batch.map((row) => ({
            tokenId: tokenIds.get(row.symbol) as string,
            baseTokenId: tokenIds.get(row.baseSymbol) as string,
            price: row.price,
            timestamp: row.at,
            source: DEMO_PRICE_SOURCE,
            granularity: 'daily',
          }))
        )
        .onConflictDoNothing();
    });

    const accountIds = new Map<string, string>();
    for (const account of dataset.accounts) accountIds.set(account.key, account.id);
    await db.insert(schema.accounts).values(
      dataset.accounts.map((account) => ({
        id: account.id,
        userId: dataset.user.id,
        institutionId: institutionIds.get(account.institution) as string,
        name: account.name,
        typeId: accountTypes.get(account.typeCode) as string,
        description: account.description,
        metadata: account.metadata,
        createdAt: account.createdAt,
        updatedAt: account.createdAt,
      }))
    );

    const holdingIds = new Map<string, string>();
    for (const holding of dataset.holdings) holdingIds.set(holding.key, holding.id);
    await db.insert(schema.holdings).values(
      dataset.holdings.map((holding) => ({
        id: holding.id,
        userId: dataset.user.id,
        accountId: accountIds.get(holding.accountKey) as string,
        tokenId: tokenIds.get(holding.symbol) as string,
        balance: holding.balance,
        source: holding.source,
        arrival: holding.arrival,
        label: holding.label,
        createdAt: holding.createdAt,
        lastUpdated: holding.lastUpdated,
      }))
    );

    await db.insert(schema.holdingCoverage).values(
      dataset.holdings.map((holding) => ({
        holdingId: holding.id,
        firstTxAt: holding.firstTxAt,
        lastTxAt: holding.lastTxAt,
        txSources: [...holding.txSources],
        hasCompleteTxHistory: true,
        lastReconciledAt: holding.lastUpdated,
      }))
    );

    await insertChunked(dataset.transactions, async (batch) => {
      await db.insert(schema.holdingTransactions).values(
        batch.map((tx) => ({
          id: tx.id,
          userId: dataset.user.id,
          holdingId: holdingIds.get(tx.holdingKey) as string,
          tokenId: tokenIds.get(tx.symbol) as string,
          kind: tx.kind,
          quantity: tx.quantity,
          priceNative: tx.priceNative,
          priceNativeTokenId: tx.priceNativeSymbol
            ? (tokenIds.get(tx.priceNativeSymbol) as string)
            : null,
          occurredAt: tx.occurredAt,
          externalId: tx.externalId,
          source: tx.source,
          swapGroupId: tx.swapGroupId,
          transferGroupId: tx.transferGroupId,
          transferReview: tx.transferReview,
          transferReviewedAt: tx.transferReviewedAt,
          transferReviewSource: tx.transferReviewSource,
          counterparty: tx.counterparty,
          description: tx.description,
        }))
      );
    });

    await insertChunked(dataset.observations, async (batch) => {
      await db
        .insert(schema.holdingBalanceObservations)
        .values(
          batch.map((observation) => ({
            id: observation.id,
            userId: dataset.user.id,
            holdingId: holdingIds.get(observation.holdingKey) as string,
            balance: observation.balance,
            observedAt: observation.observedAt,
            source: observation.source,
          }))
        )
        .onConflictDoNothing();
    });

    const baseCurrencyId = tokenIds.get(dataset.user.baseCurrency) as string;
    const scopeId = (row: (typeof dataset.rollups)[number]): string => {
      switch (row.scopeKind) {
        case 'user':
          return dataset.user.id;
        case 'account':
          return accountIds.get(row.scopeRef) as string;
        case 'institution':
          return institutionIds.get(row.scopeRef) as string;
        default:
          return holdingIds.get(row.scopeRef) as string;
      }
    };
    await insertChunked(dataset.rollups, async (batch) => {
      await db.insert(schema.portfolioValueDaily).values(
        batch.map((row) => ({
          userId: dataset.user.id,
          scopeKind: row.scopeKind,
          scopeId: scopeId(row),
          snapshotDate: row.snapshotDate,
          baseCurrencyId,
          totalValue: row.totalValue,
          coverageQuality: row.coverageQuality,
          holdingsWithKnownValue: row.holdingsWithKnownValue,
          holdingsTotal: row.holdingsTotal,
          holdingsUnpriceable: 0,
          holdingsStalePriced: 0,
          holdingsStaleAnchored: 0,
          holdingsBeforeRecords: 0,
          holdingsInterpolated: 0,
          holdingsBasisUnknown: 0,
          transfersUnreviewed: row.transfersUnreviewed,
          costBasis: row.costBasis,
          realizedPnl: row.realizedPnl,
          unrealizedPnl: row.unrealizedPnl,
          computedAt: row.computedAt,
        }))
      );
    });

    await db.insert(schema.groups).values(
      dataset.groups.map((group) => ({
        id: group.id,
        userId: dataset.user.id,
        name: group.name,
        color: group.color,
        description: group.description,
        displayOrder: group.displayOrder,
      }))
    );
    await db.insert(schema.holdingGroups).values(
      dataset.groups.flatMap((group) =>
        group.holdingKeys.map((key) => ({
          holdingId: holdingIds.get(key) as string,
          groupId: group.id,
        }))
      )
    );
    await db.insert(schema.accountGroups).values(
      dataset.groups.flatMap((group) =>
        group.accountKeys.map((key) => ({
          accountId: accountIds.get(key) as string,
          groupId: group.id,
        }))
      )
    );

    await db.insert(schema.vaults).values(
      dataset.vaults.map((vault) => ({
        id: vault.id,
        userId: dataset.user.id,
        name: vault.name,
        description: vault.description,
        targetAmount: vault.targetAmount,
        currencyId: baseCurrencyId,
        currentAmount: vault.currentAmount,
        color: vault.color,
        iconName: vault.iconName,
      }))
    );
    await db.insert(schema.vaultHoldings).values(
      dataset.vaults.flatMap((vault) =>
        vault.allocations.map((allocation) => ({
          vaultId: vault.id,
          holdingId: holdingIds.get(allocation.holdingKey) as string,
          percentage: allocation.percentage,
        }))
      )
    );

    await db.insert(schema.userWallets).values(
      dataset.wallets.map((wallet) => ({
        id: wallet.id,
        userId: dataset.user.id,
        walletAddress: wallet.walletAddress,
        institutionIds: [institutionIds.get(wallet.institution) as string],
        label: wallet.label,
      }))
    );

    await db.insert(schema.holdingApyConfigs).values(
      dataset.apyConfigs.map((config) => ({
        holdingId: holdingIds.get(config.holdingKey) as string,
        annualRatePct: config.annualRatePct,
        payoutFrequency: config.payoutFrequency,
        payoutDayOfMonth: config.payoutDayOfMonth,
        lastPayoutAt: config.lastPayoutAt,
      }))
    );

    const vendorIds = new Map<string, string>();
    for (const vendor of dataset.vendors) vendorIds.set(vendor.key, vendor.id);
    await db.insert(schema.vendors).values(
      dataset.vendors.map((vendor) => ({
        id: vendor.id,
        userId: dataset.user.id,
        displayName: vendor.displayName,
        normalizedName: vendor.normalizedName,
        category: vendor.category,
        website: vendor.website,
      }))
    );
    await db.insert(schema.vendorAliases).values(
      dataset.vendors.flatMap((vendor) =>
        vendor.aliases.map((rawName) => ({
          vendorId: vendor.id,
          rawName,
          source: 'counterparty',
        }))
      )
    );

    const paymentIds = new Map<string, string>();
    for (const payment of dataset.payments) paymentIds.set(payment.key, payment.id);
    await db.insert(schema.payments).values(
      dataset.payments.map((payment) => ({
        id: payment.id,
        userId: dataset.user.id,
        vendorId: vendorIds.get(payment.vendorKey) as string,
        direction: payment.direction,
        kind: payment.kind,
        expectedAmount: payment.expectedAmount,
        currencyTokenId: tokenIds.get(payment.currency) as string,
        intervalUnit: payment.intervalUnit,
        intervalCount: payment.intervalCount,
        anchorDate: payment.anchorDate,
        accountId: accountIds.get(payment.accountKey) as string,
        origin: 'manual',
        notes: payment.notes,
        createdAt: payment.createdAt,
        updatedAt: payment.createdAt,
      }))
    );
    await insertChunked(dataset.occurrences, async (batch) => {
      await db.insert(schema.paymentOccurrences).values(
        batch.map((occurrence) => ({
          id: occurrence.id,
          paymentId: paymentIds.get(occurrence.paymentKey) as string,
          dueDate: occurrence.dueDate,
          expectedAmount: occurrence.expectedAmount,
          actualAmount: occurrence.actualAmount,
          status: occurrence.status,
          matchedTransactionId: occurrence.transactionId,
        }))
      );
    });

    await db.insert(schema.documents).values(
      dataset.documents.map((document) => ({
        id: document.id,
        userId: dataset.user.id,
        purpose: document.purpose,
        r2Key: document.r2Key,
        contentHash: document.contentHash,
        mimeType: document.mimeType,
        byteSize: document.byteSize,
        originalFilename: document.originalFilename,
        sourceKind: document.sourceKind,
        classification: document.classification,
        classificationConfidence: document.classificationConfidence,
        createdAt: document.createdAt,
      }))
    );
    await db.insert(schema.documentExtractions).values(
      dataset.extractions.map((extraction) => ({
        id: extraction.id,
        documentId: extraction.documentId,
        ordinal: extraction.ordinal,
        vendorNameRaw: extraction.vendorNameRaw,
        vendorId: vendorIds.get(extraction.vendorKey) as string,
        invoiceNumber: extraction.invoiceNumber,
        issueDate: extraction.issueDate,
        dueDate: extraction.dueDate,
        totalAmount: extraction.totalAmount,
        currencyCode: extraction.currencyCode,
        lineItems: extraction.lineItems,
        confidence: extraction.confidence,
        paymentStatus: extraction.paymentStatus,
        billingPeriod: extraction.billingPeriod,
        extractorKind: 'demo-dataset',
        promptVersion: 'demo',
        reviewState: extraction.reviewState,
        createdAt: extraction.createdAt,
      }))
    );

    const summary: DemoSeedSummary = {
      userId: dataset.user.id,
      anchorDate: dataset.anchorDate,
      startDate: dataset.startDate,
      counts: {
        prices: dataset.prices.length,
        accounts: dataset.accounts.length,
        holdings: dataset.holdings.length,
        transactions: dataset.transactions.length,
        observations: dataset.observations.length,
        rollups: dataset.rollups.length,
        groups: dataset.groups.length,
        vaults: dataset.vaults.length,
        vendors: dataset.vendors.length,
        payments: dataset.payments.length,
        occurrences: dataset.occurrences.length,
        documents: dataset.documents.length,
        extractions: dataset.extractions.length,
        wallets: dataset.wallets.length,
      },
    };
    logger.info(summary, 'demo dataset written');
    return summary;
  }

  private async codeMap(
    table: typeof schema.tokenTypes | typeof schema.accountTypes | typeof schema.institutionTypes
  ): Promise<Map<string, string>> {
    const rows = await db.select({ id: table.id, code: table.code }).from(table);
    return new Map(rows.map((row) => [row.code, row.id]));
  }

  /**
   * The fiat row migration `0000` seeded, resolved on the identity tuple
   * rather than by symbol alone. `findBySymbol`-style lookups tie-break toward
   * the newest row, which for `USD` and `EUR` is a memecoin rather than the
   * currency (SC-223/SC-315) — the same trap `price-hubs.ts` documents.
   */
  private async fiatTokenId(symbol: string, tokenTypes: Map<string, string>): Promise<string> {
    const [row] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(
        and(
          eq(schema.tokens.symbol, symbol),
          eq(schema.tokens.typeId, tokenTypes.get('fiat') as string),
          isNull(schema.tokens.marketSegment)
        )
      );
    if (!row) {
      throw new Error(
        `demo dataset: no fiat token ${symbol} — run \`bun run db:migrate\` before seeding`
      );
    }
    return row.id;
  }

  private async ensureToken(
    token: { symbol: string; name: string; decimals: number; marketSegment: string | null },
    typeId: string
  ): Promise<string> {
    const [existing] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(
        and(
          eq(schema.tokens.symbol, token.symbol),
          eq(schema.tokens.typeId, typeId),
          sql`coalesce(${schema.tokens.marketSegment}, '') = coalesce(${token.marketSegment}, '')`
        )
      );
    if (existing) return existing.id;
    const [created] = await db
      .insert(schema.tokens)
      .values({
        symbol: token.symbol,
        name: token.name,
        typeId,
        decimals: token.decimals,
        marketSegment: token.marketSegment,
      })
      .returning({ id: schema.tokens.id });
    return (created as { id: string }).id;
  }

  private async ensureInstitution(name: string, typeId: string): Promise<string> {
    const [existing] = await db
      .select({ id: schema.institutions.id })
      .from(schema.institutions)
      .where(eq(schema.institutions.name, name));
    if (existing) return existing.id;
    const [created] = await db
      .insert(schema.institutions)
      .values({ name, typeId, hasIntegration: false })
      .returning({ id: schema.institutions.id });
    return (created as { id: string }).id;
  }
}
