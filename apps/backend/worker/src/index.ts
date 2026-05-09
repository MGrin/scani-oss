import 'reflect-metadata';
// CRITICAL: Validate env before importing modules that read process.env.
import { loadEnv } from './config/env';

const env = loadEnv();

import { loadCloudClientConfig } from '@scani/cloud-client';
import { probeDataProvider } from '@scani/cloud-client/health-probe';
// Import DI-registered modules so Container.get() resolves the @scani/domain
// services + repositories the processors inject.
import '@scani/domain/repositories';
import '@scani/domain/services';
// Import @scani/jobs so its @Service-decorated mirrors + lock register against
// the framework's tokens BEFORE WorkerClient.start resolves them.
import '@scani/jobs';
import { awaitSchemaReady, db } from '@scani/db';
import { SCHEDULED_JOB_DESCRIPTORS } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { buildProviderRegistry } from '@scani/providers/core/boot';
import { aiOpenAIFactory } from '@scani/providers/providers/ai-openai';
import { binanceFactory } from '@scani/providers/providers/binance';
import { bitcoinFactory } from '@scani/providers/providers/bitcoin';
import { bitgetFactory } from '@scani/providers/providers/bitget';
import { bitstampFactory } from '@scani/providers/providers/bitstamp';
import { bybitFactory } from '@scani/providers/providers/bybit';
import { coinbaseFactory } from '@scani/providers/providers/coinbase';
import { coingeckoFactory } from '@scani/providers/providers/coingecko';
import { defillamaFactory } from '@scani/providers/providers/defillama';
import { etherscanFactory } from '@scani/providers/providers/etherscan';
import { finnhubFactory } from '@scani/providers/providers/finnhub';
import { frankfurterFactory } from '@scani/providers/providers/frankfurter';
import { gateFactory } from '@scani/providers/providers/gate';
import { geminiFactory } from '@scani/providers/providers/gemini';
import { huobiFactory } from '@scani/providers/providers/huobi';
import { ibkrFactory } from '@scani/providers/providers/ibkr';
import { krakenFactory } from '@scani/providers/providers/kraken';
import { kucoinFactory } from '@scani/providers/providers/kucoin';
import { mexcFactory } from '@scani/providers/providers/mexc';
import { okxFactory } from '@scani/providers/providers/okx';
import { solanaFactory } from '@scani/providers/providers/solana';
import { tonFactory } from '@scani/providers/providers/ton';
import { tronFactory } from '@scani/providers/providers/tron';
import { wiseFactory } from '@scani/providers/providers/wise';
import { yahooFinanceFactory } from '@scani/providers/providers/yahoo-finance';
import { googleSheetsFactory } from '@scani/providers-google-sheets';
import {
  JobScheduler,
  QueueClient,
  RedisLifecyclePublisher,
  RedisResourceLock,
  WorkerClient,
} from '@scani/queue';
import { setSharedRedis } from '@scani/rate-limiter';

initSentry({ component: 'worker', release: env.SENTRY_RELEASE });

// Fail fast if SCANI_CLOUD_URL is set but the data-provider is unreachable.
// Otherwise misconfigs let the worker start consuming jobs that then 5xx
// on every chain/AI/storage call — corrupts retry budgets fast.
{
  const probe = await probeDataProvider();
  if (!probe.ok) {
    console.error(
      `\n❌ Data-provider unreachable at ${probe.url} after ${probe.attempts} attempt(s): ${probe.error ?? `HTTP ${probe.status}`}\n` +
        'Worker cannot start in cloud mode without a healthy data-provider.\n' +
        'Either fix SCANI_CLOUD_URL, restore the data-provider, or unset the env to fall back to local providers.'
    );
    process.exit(1);
  }
}

import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { Redis } from 'ioredis';
import { Container } from 'typedi';
// Side-effect imports so each processor's @Service decorator runs and
// the class registers with the typedi Container before WorkerClient
// pulls them out and registers them.
import { ApyPayoutsProcessor } from './processors/apy-payouts';
import { BackfillTokenIdentityProcessor } from './processors/backfill-token-identity';
import { DlqDepthProbeProcessor } from './processors/dlq-depth-probe';
import { ExchangeBalancesProcessor } from './processors/exchange-balances';
import { ExchangeImportProcessor } from './processors/exchange-import';
import { FileImportProcessor } from './processors/file-import';
import { ForexBackfillProcessor } from './processors/forex-backfill';
import { HideClosedHoldingsProcessor } from './processors/hide-closed-holdings';
import { HistoricalPriceBackfillProcessor } from './processors/historical-price-backfill';
import { HoldingPriceUpdateProcessor } from './processors/holding-price-update';
import { IngestTransactionsProcessor } from './processors/ingest-transactions';
import { ManualHoldingsCreateProcessor } from './processors/manual-holdings-create';
import { PortfolioHistoryBackfillProcessor } from './processors/portfolio-history-backfill';
import { PortfolioValueRollupProcessor } from './processors/portfolio-value-rollup';
import { PricingProcessor } from './processors/pricing';
import { ReconcileOrphanedUserJobsProcessor } from './processors/reconcile-orphaned-user-jobs';
import { ReconcilePendingCredentialsProcessor } from './processors/reconcile-pending-credentials';
import { RefreshAccountBalanceProcessor } from './processors/refresh-account-balance';
import { ScreenshotParseProcessor } from './processors/screenshot-parse';
import { TransferLinkingProcessor } from './processors/transfer-linking';
import { UserDataDeleteProcessor } from './processors/user-data-delete';
import { WalletBalancesProcessor } from './processors/wallet-balances';
import { WalletImportProcessor } from './processors/wallet-import';

const logger = createComponentLogger('worker');

// Single declarative list of processor instances. Adding a new async
// job is one new descriptor in @scani/jobs + one new processor class +
// one entry here. Container.get is called eagerly so any DI failure
// surfaces at boot rather than first-job-arrives.
function resolveProcessors() {
  return [
    // Scheduled / cron-triggered (no payload, lock via descriptor.lockName).
    Container.get(PricingProcessor),
    Container.get(WalletBalancesProcessor),
    Container.get(ExchangeBalancesProcessor),
    Container.get(ApyPayoutsProcessor),
    Container.get(HistoricalPriceBackfillProcessor),
    Container.get(ForexBackfillProcessor),
    Container.get(PortfolioValueRollupProcessor),
    Container.get(TransferLinkingProcessor),
    Container.get(BackfillTokenIdentityProcessor),
    Container.get(HideClosedHoldingsProcessor),
    Container.get(ReconcilePendingCredentialsProcessor),
    Container.get(ReconcileOrphanedUserJobsProcessor),
    Container.get(DlqDepthProbeProcessor),
    // User-initiated (payload via UserJobDescriptor schema).
    Container.get(ScreenshotParseProcessor),
    Container.get(ExchangeImportProcessor),
    Container.get(WalletImportProcessor),
    Container.get(FileImportProcessor),
    Container.get(ManualHoldingsCreateProcessor),
    Container.get(PortfolioHistoryBackfillProcessor),
    Container.get(HoldingPriceUpdateProcessor),
    Container.get(RefreshAccountBalanceProcessor),
    Container.get(UserDataDeleteProcessor),
    Container.get(IngestTransactionsProcessor),
  ];
}

async function main(): Promise<void> {
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      scaniCloudUrl: loadCloudClientConfig().SCANI_CLOUD_URL ?? '(local fallback)',
    },
    '🚀 Starting Scani worker'
  );

  // Stand up the @scani/providers registry — single source of truth for
  // pricing/balance/tx/identity/AI dispatch.
  {
    const providerRedis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    const built = await buildProviderRegistry({
      mode: 'direct',
      redis: providerRedis,
      env: process.env,
      providers: [
        // Pricing — public APIs.
        defillamaFactory,
        frankfurterFactory,
        coingeckoFactory,
        finnhubFactory,
        // Yahoo runs *after* Finnhub by registration order so US-listed
        // equities still go to Finnhub first; Yahoo fills the gap for
        // non-US listings (.TO/.NE/.L/.DE/…) and Frankfurter-unsupported
        // fiat (RUB after 2022, KZT, GEL, AED, …) where Frankfurter
        // returns null on historical lookups.
        yahooFinanceFactory,
        // Chain providers — public-endpoint balance + address-validator
        // dispatch for wallet sync flows.
        etherscanFactory,
        bitcoinFactory,
        solanaFactory,
        tronFactory,
        tonFactory,
        // CEX — user-credentialed balance sync + credential validation.
        // Kraken's HistoricalPriceProvider also covers CEX-native asset
        // codes (XXBT, ZUSD, …) that DeFiLlama / CoinGecko miss.
        binanceFactory,
        coinbaseFactory,
        krakenFactory,
        bybitFactory,
        okxFactory,
        kucoinFactory,
        gateFactory,
        bitgetFactory,
        bitstampFactory,
        huobiFactory,
        mexcFactory,
        geminiFactory,
        // Brokers + fiat.
        ibkrFactory,
        wiseFactory,
        // AI: OpenAI is the only AI provider.
        aiOpenAIFactory,
      ],
    });
    // GoogleSheets — see comment in apps/backend/api/src/index.ts for
    // why it lives in its own workspace and is registered separately.
    const googleSheetsProvider = googleSheetsFactory({
      db,
      redis: providerRedis,
      rateLimiterRegistry: built.rateLimiterRegistry,
    });
    built.registry.register(googleSheetsProvider);
    logger.info({}, '✅ @scani/providers registry initialized');
  }

  // BullMQ requires maxRetriesPerRequest: null on the ioredis connection
  // it uses for blocking commands (subscribe, bzpopmin, etc.).
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  // Separate publisher connection for WS job events so publishes don't
  // interfere with BullMQ's blocking commands on `connection`.
  const publisher = connection.duplicate();
  Container.get(RedisRealtimeUpdatesService).configure(publisher);
  Container.get(RedisLifecyclePublisher).configure(publisher);
  Container.get(RedisResourceLock).configure(publisher);

  // Make the Redis-backed rate limiter the default for every limiter
  // constructed downstream. Without this, N workers each get their own
  // full upstream-API budget.
  setSharedRedis(connection);

  // Producer side: QueueClient lets processors chain-enqueue follow-up
  // jobs (e.g., wallet-import → transaction-import per account).
  Container.get(QueueClient).configure({ connection });

  // Consumer side: WorkerClient owns the BullMQ Worker + dispatch table
  // + DLQ push on terminal failure.
  const workerClient = Container.get(WorkerClient);
  workerClient.configure({
    connection,
    concurrency: env.WORKER_CONCURRENCY,
    drainDelay: 5,
  });

  // Sentry capture is application policy, not framework concern. The
  // hook fires only on terminal failure (after BullMQ exhausts retries)
  // and only for non-UnrecoverableError causes (those are user-facing
  // by-design failures, surfaced via /jobs UI — paging Sentry would
  // bury real bugs in noise).
  workerClient.onTerminalFailure((job, err) => {
    sentryCapture(err, {
      jobName: job.name,
      jobId: String(job.id ?? 'unknown'),
    });
  });

  // Register every @Service-resolved processor with the WorkerClient
  // dispatch table. Side-effect imports above ensure the @Service
  // decorators have run and the classes are in the Container.
  for (const processor of resolveProcessors()) {
    workerClient.register(processor);
  }

  // Block scheduler registration until the canary tables are visible.
  // CI's migrate job runs before this deploy step, but Neon's
  // autoscaling-from-zero compute can lag — so the worker would fire
  // its * * * * * reconcilers against an empty schema and pile up DLQ
  // entries. Polling for to_regclass(...) waits for the migration to
  // become visible without needing migration files in the binary.
  logger.info({}, '⏳ Awaiting schema readiness before scheduler registration');
  await awaitSchemaReady();
  logger.info({}, '✅ Schema ready');

  // Reconcile repeatable schedules (upsert wanted, remove orphans).
  // Without orphan removal, deleted descriptors keep firing forever.
  await Container.get(JobScheduler).upsertAll(SCHEDULED_JOB_DESCRIPTORS);

  await workerClient.start();

  // --- Graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, '🛑 Shutdown signal received — draining worker');
    try {
      await workerClient.close();
      await Container.get(QueueClient).close();
      await publisher.quit();
      await connection.quit();
      await flushSentry(2000);
      logger.info({}, '✅ Worker drained cleanly');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, '❌ Error during shutdown');
      await flushSentry(2000);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Survive transient postgres.js socket drops. Neon's pooled endpoint
  // closes idle TCP connections on its own clock; the driver then
  // tries to write Sync to a half-closed socket and dereferences a
  // null `write` (`TypeError: null is not an object (evaluating
  // 'v.write')` — Sentry, 2026-05-07 03:31 UTC). Bubbled all the way
  // up, that took down the worker mid-cron.
  //
  // postgres.js auto-reconnects on the next query, so logging+swallowing
  // here lets the next BullMQ job re-acquire a fresh connection from
  // the pool. We still report to Sentry so a rising error rate is
  // visible, and we still exit on truly fatal errors (any non-Postgres
  // / non-write-after-close TypeError) so we don't paper over real bugs.
  const POSTGRES_TRANSIENT_ERROR =
    /CONNECTION_CLOSED|null is not an object \(evaluating 'v\.write'\)|write after end/i;
  process.on('uncaughtException', (error: Error) => {
    if (POSTGRES_TRANSIENT_ERROR.test(error.message)) {
      logger.warn(
        { error: error.message },
        '⚠️ Transient postgres connection error — driver will reconnect'
      );
      sentryCapture(error);
      return;
    }
    logger.error({ error }, '💥 Unhandled exception in worker — exiting');
    sentryCapture(error);
    void flushSentry(2000).then(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (POSTGRES_TRANSIENT_ERROR.test(err.message)) {
      logger.warn({ error: err.message }, '⚠️ Transient postgres rejection — driver will reconnect');
      sentryCapture(err);
      return;
    }
    logger.error({ error: err }, '💥 Unhandled rejection in worker — exiting');
    sentryCapture(err);
    void flushSentry(2000).then(() => process.exit(1));
  });
}

main().catch(async (error) => {
  logger.error({ error }, '💥 Unhandled error in worker');
  sentryCapture(error);
  await flushSentry(2000);
  process.exit(1);
});
