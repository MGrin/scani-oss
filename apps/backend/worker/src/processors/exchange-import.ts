import crypto from 'node:crypto';
import { ANALYTICS_EVENTS, AnalyticsService } from '@scani/analytics';
import { PortfolioValueCache } from '@scani/domain/services';
import { ImportExchangeAccountsUseCase, ImportIbkrAccountsUseCase } from '@scani/domain/use-cases';
import {
  EXCHANGE_IMPORT,
  type ExchangeImportJob,
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  TRANSACTION_IMPORT,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
} from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:exchange-import');

// 5 minutes — see ingest-transactions.ts for the rationale (an import
// wave easily spans more than 30s; the coarser bucket collapses the
// session to a single backfill).
const BACKFILL_COALESCE_WINDOW_MS = 5 * 60_000;

// Pick a stable `source` tag for an exchange provider. These match the
// `readonly source = '…'` fields on the CEX TransactionIngester classes.
// Providers we don't have an ingester for return null — the
// transaction-import chain is skipped; balance-only imports still work.
function sourceForProvider(provider: string): string | null {
  const p = provider.toLowerCase();
  const map: Record<string, string> = {
    kraken: 'kraken-api',
    binance: 'binance-api',
    bybit: 'bybit-api',
    okx: 'okx-api',
    coinbase: 'coinbase-api',
    kucoin: 'kucoin-api',
    'gate.io': 'gate-api',
    gateio: 'gate-api',
    gate: 'gate-api',
    bitget: 'bitget-api',
    huobi: 'huobi-api',
    mexc: 'mexc-api',
    bitstamp: 'bitstamp-api',
    gemini: 'gemini-api',
    ibkr: 'ibkr-api',
    'interactive brokers': 'ibkr-api',
  };
  return map[p] ?? null;
}

// Classify failures that re-running will not fix, so BullMQ skips
// retries and the user sees the real error immediately on the job page.
// Auto-retry is fine for transient network failures, but exchange
// imports mostly fail on user-actionable conditions: bad credentials,
// expired tokens, missing permissions, provider rate limits. Retrying
// rate-limit errors actively makes them worse.
function isUnrecoverableExchangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /IBKR Flex Query error \(code 10(01|10|12|18)\)/.test(msg) ||
    /IBKR report still generating after \d+ retries/.test(msg) ||
    /IBKR SendRequest still transient after \d+ retries/.test(msg) ||
    /HTTP 40[13]/.test(msg) ||
    /EAPI:Invalid (signature|nonce|key)/.test(msg) ||
    /rejected request: retCode (10003|10004|10005|10006|33004)/.test(msg) ||
    /apikey: invalid/i.test(msg) ||
    /bitbank error code/.test(msg) ||
    /Tiger Brokers error/.test(msg) ||
    /Zerodha (login|2FA|session\/token|OAuth) (failed|did not produce)/.test(msg) ||
    /Zerodha OAuth redirect produced no request_token/.test(msg) ||
    /Zerodha: (Invalid|Expired|Token|Input|User)/.test(msg) ||
    /No wallet manager available or missing userId in credentials/.test(msg) ||
    /Exchange-import targeted a blockchain-type institution/.test(msg)
  );
}

// Exported for unit tests.
export const __test_isUnrecoverableExchangeError = isUnrecoverableExchangeError;

@Service()
export class ExchangeImportProcessor extends UserJobProcessor<ExchangeImportJob, unknown> {
  readonly descriptor = EXCHANGE_IMPORT;
  private readonly enqueueService = Container.get(BullMqEnqueueService);

  protected async handle(data: ExchangeImportJob, ctx: ProcessorContext): Promise<unknown> {
    const useCase =
      data.provider.toLowerCase() === 'interactive brokers' ||
      data.provider.toLowerCase() === 'ibkr'
        ? Container.get(ImportIbkrAccountsUseCase)
        : Container.get(ImportExchangeAccountsUseCase);

    let result: Awaited<ReturnType<typeof useCase.execute>>;
    try {
      result = await useCase.execute({
        userId: data.userId,
        institutionId: data.institutionId,
        onStatus: (message) => ctx.reportStatus(message),
      });
    } catch (error) {
      if (isUnrecoverableExchangeError(error)) {
        // BullMQ UnrecoverableError short-circuits the retry policy —
        // the job goes to `failed` immediately instead of re-running.
        const msg = error instanceof Error ? error.message : String(error);
        throw new UnrecoverableError(msg);
      }
      throw error;
    }

    for (const account of result.accounts) {
      emitEntityChange({
        entityType: 'account',
        operationType: 'create',
        entityId: account.id,
        userId: data.userId,
      });
    }
    for (const holding of result.holdings) {
      emitEntityChange({
        entityType: 'holding',
        operationType: 'create',
        entityId: holding.id,
        userId: data.userId,
        data: { accountId: holding.accountId },
      });
    }
    if (result.holdings.length > 0) {
      emitEntityChange({
        entityType: 'holding',
        operationType: 'sync',
        userId: data.userId,
        data: { reason: 'exchange_import', holdingsAffected: result.holdings.length },
      });

      // New holdings/balances were imported — drop the user's cached
      // portfolio valuation so the next read recomputes.
      await Container.get(PortfolioValueCache).bust(data.userId);
    }

    // Chain-enqueue transaction-import per account so /jobs shows each
    // account's tx history individually + failure in one doesn't block
    // others. Skip when no ingester source is mapped — balance import
    // already succeeded and that's fine on its own.
    const source = sourceForProvider(data.provider);
    if (source && result.accounts.length > 0) {
      for (const account of result.accounts) {
        try {
          await this.enqueueService.add(TRANSACTION_IMPORT, {
            userId: data.userId,
            requestId: crypto.randomUUID(),
            accountId: account.id,
            source,
            institutionId: data.institutionId,
          });
        } catch (error) {
          logger.warn(
            {
              accountId: account.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to chain-enqueue transaction-import'
          );
        }
      }
    }

    // Also enqueue portfolio-history-backfill so the net-worth chart
    // fills in immediately after a balance import — even when the
    // chained transaction-import returns 0 events (e.g., IBKR Flex
    // Query templates without Trades/CashTransactions sections, or
    // brand-new exchange accounts with no trade history). The backfill
    // pulls historical prices for the new tokens and rolls daily
    // portfolio values; the per-user advisory lock inside the
    // processor de-dupes against any concurrent trigger from
    // ingest-transactions, so this is safe to fire alongside.
    if (result.accounts.length > 0) {
      const bucket = Math.floor(Date.now() / BACKFILL_COALESCE_WINDOW_MS);
      try {
        await this.enqueueService.add(PORTFOLIO_HISTORY_BACKFILL, {
          userId: data.userId,
          requestId: `exchange-import-${bucket}`,
          tokenIds: [],
          lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
        });
      } catch (error) {
        logger.warn(
          {
            userId: data.userId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to chain-enqueue portfolio-history-backfill'
        );
      }
    }

    // Per-account errors AND nothing imported → fail loudly rather than
    // show a green "success" row with hidden errors. Partial success
    // (some imported, some failed) still succeeds with errors visible.
    if (result.errors.length > 0 && result.accountsCreated === 0) {
      const summary = result.errors.map((e) => e.error ?? 'unknown').join('; ');
      throw new UnrecoverableError(`Exchange import produced no accounts; errors: ${summary}`);
    }

    Container.get(AnalyticsService).capture({
      distinctId: data.userId,
      event: ANALYTICS_EVENTS.importCompleted,
      app: 'backend',
      properties: {
        kind: 'exchange',
        provider: data.provider,
        accounts_created: result.accountsCreated,
        tokens_imported: result.tokensImported,
      },
    });

    return {
      accountsCreated: result.accountsCreated,
      tokensImported: result.tokensImported,
      errors: result.errors,
      transactionImportSource: source,
      transactionImportEnqueued: source ? result.accounts.length : 0,
    };
  }
}
