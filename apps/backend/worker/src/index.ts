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
import { aiStubFactory } from '@scani/providers/providers/ai-stub';
import { airwallexFactory } from '@scani/providers/providers/airwallex';
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

// Probe the data-provider at boot. The previous version exited on
// failure; the 2026-05-09 outage taught us that a transient
// dependency unreachability turns into a hard-down when the worker
// crashes on a rolling deploy of data-provider. We now warn + log +
// Sentry, leaving boot to proceed; user/cron jobs that need cloud
// providers will surface their own retries via BullMQ if data-provider
// is still down at processing time. A background re-probe (registered
// further down) tracks recovery.
let dataProviderReachable = true;
{
  const probe = await probeDataProvider();
  if (!probe.ok) {
    dataProviderReachable = false;
    const message = `Data-provider unreachable at ${probe.url} after ${probe.attempts} attempt(s): ${probe.error ?? `HTTP ${probe.status}`}`;
    console.warn(`⚠️  ${message}`);
    // Sentry init has happened above; capture immediately so the
    // alert fires even if the worker process is killed before the
    // re-probe loop runs.
    sentryCapture(new Error(message), {
      component: 'worker',
      kind: 'data-provider-boot-unreachable',
    });
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
import { ExchangeTransactionsProcessor } from './processors/exchange-transactions';
import { FileImportProcessor } from './processors/file-import';
import { ForexBackfillProcessor } from './processors/forex-backfill';
import { HideClosedHoldingsProcessor } from './processors/hide-closed-holdings';
import { HistoricalPriceBackfillProcessor } from './processors/historical-price-backfill';
import { HoldingPriceUpdateProcessor } from './processors/holding-price-update';
import { IngestTransactionsProcessor } from './processors/ingest-transactions';
import { JobHeartbeatProbeProcessor } from './processors/job-heartbeat-probe';
import { ManualHoldingsCreateProcessor } from './processors/manual-holdings-create';
import { PortfolioHistoryBackfillProcessor } from './processors/portfolio-history-backfill';
import { PortfolioValueRollupProcessor } from './processors/portfolio-value-rollup';
import { PricingProcessor } from './processors/pricing';
import { ReconcileOrphanedUserJobsProcessor } from './processors/reconcile-orphaned-user-jobs';
import { ReconcilePendingCredentialsProcessor } from './processors/reconcile-pending-credentials';
import { RefreshAccountBalanceProcessor } from './processors/refresh-account-balance';
import { ScreenshotParseProcessor } from './processors/screenshot-parse';
import { StaleSyncProbeProcessor } from './processors/stale-sync-probe';
import { TokenPricesDownsampleProcessor } from './processors/token-prices-downsample';
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
    Container.get(ExchangeTransactionsProcessor),
    Container.get(ApyPayoutsProcessor),
    Container.get(HistoricalPriceBackfillProcessor),
    Container.get(ForexBackfillProcessor),
    Container.get(TokenPricesDownsampleProcessor),
    Container.get(PortfolioValueRollupProcessor),
    Container.get(TransferLinkingProcessor),
    Container.get(BackfillTokenIdentityProcessor),
    Container.get(HideClosedHoldingsProcessor),
    Container.get(ReconcilePendingCredentialsProcessor),
    Container.get(ReconcileOrphanedUserJobsProcessor),
    Container.get(DlqDepthProbeProcessor),
    Container.get(JobHeartbeatProbeProcessor),
    Container.get(StaleSyncProbeProcessor),
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
        airwallexFactory,
        // AI: STUB_AI=1 registers a fixed-payload provider FIRST so the
        // e2e suite gets deterministic screenshot-parse results without
        // an OpenAI key. The data-provider config schema refuses
        // STUB_AI=1 in production, so a misconfigured prod deploy would
        // crash at boot before this branch ever fires.
        ...(process.env.STUB_AI === '1' ? [aiStubFactory] : []),
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
  // Default the cron cap to half the global pool so user jobs always
  // have headroom even when the hourly tide arrives. Explicit 0 → no
  // cap (legacy behaviour); explicit value → use as-is.
  const cronConcurrency =
    env.WORKER_CONCURRENCY_CRON ?? Math.max(1, Math.ceil(env.WORKER_CONCURRENCY / 2));
  workerClient.configure({
    connection,
    concurrency: env.WORKER_CONCURRENCY,
    cronConcurrency: cronConcurrency > 0 ? cronConcurrency : undefined,
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

  // --- Data-provider re-probe ----------------------------------------------
  // Background re-probe so a transient unavailability at boot doesn't
  // latch the worker into a degraded state forever. Logs recovery once
  // the data-provider goes green again.
  {
    const REPROBE_INTERVAL_MS = 60_000;
    const probeTimer = setInterval(() => {
      void (async () => {
        try {
          const probe = await probeDataProvider();
          if (probe.ok) {
            if (!dataProviderReachable) {
              logger.info(
                { url: probe.url, attempts: probe.attempts },
                '☁️  Data-provider reachable (recovered)'
              );
              dataProviderReachable = true;
            }
            return;
          }
          if (dataProviderReachable) {
            logger.warn(
              { url: probe.url, error: probe.error, status: probe.status },
              '⚠️  Data-provider unreachable (in re-probe)'
            );
            sentryCapture(
              new Error(`data-provider re-probe failed: ${probe.error ?? probe.status}`),
              {
                component: 'worker',
                kind: 'data-provider-reprobe-failed',
              }
            );
            dataProviderReachable = false;
          }
        } catch (err) {
          logger.warn({ err }, '⚠️  Data-provider re-probe threw');
        }
      })();
    }, REPROBE_INTERVAL_MS);
    probeTimer.unref?.();
  }

  // --- Redis liveness monitor ----------------------------------------------
  // ioredis retries forever on Redis loss by default; the worker process
  // stays alive but BullMQ's blocking consumer can't recover. Without an
  // explicit health gate, a multi-hour Upstash outage looks identical to
  // "everything is fine" from Fly's side. The monitor pings Redis every
  // 30s; after 3 consecutive failures (~90s of degradation) we exit so
  // Fly restarts the machine and the new process re-establishes the
  // connection from scratch.
  const REDIS_PING_INTERVAL_MS = 30_000;
  const REDIS_PING_TIMEOUT_MS = 5_000;
  const REDIS_MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  const redisMonitor = setInterval(() => {
    void (async () => {
      try {
        const ping = connection.ping();
        const result = await Promise.race([
          ping,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('redis ping timed out')), REDIS_PING_TIMEOUT_MS)
          ),
        ]);
        if (result === 'PONG') {
          if (consecutiveFailures > 0) {
            logger.info({ previousFailures: consecutiveFailures }, '✅ Redis liveness restored');
          }
          consecutiveFailures = 0;
          return;
        }
        throw new Error(`unexpected ping response: ${String(result)}`);
      } catch (err) {
        consecutiveFailures++;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ consecutiveFailures, error: message }, '⚠️ Redis liveness ping failed');
        if (consecutiveFailures >= REDIS_MAX_CONSECUTIVE_FAILURES) {
          logger.fatal(
            {
              consecutiveFailures,
              thresholdMs: REDIS_PING_INTERVAL_MS * REDIS_MAX_CONSECUTIVE_FAILURES,
            },
            '💀 Redis unreachable for ' +
              `${(REDIS_PING_INTERVAL_MS * REDIS_MAX_CONSECUTIVE_FAILURES) / 1000}s — ` +
              'exiting so Fly restarts the machine'
          );
          sentryCapture(err instanceof Error ? err : new Error(String(err)), {
            kind: 'redis-liveness-exhausted',
            consecutiveFailures: String(consecutiveFailures),
          });
          await flushSentry(2000);
          process.exit(1);
        }
      }
    })();
  }, REDIS_PING_INTERVAL_MS);
  redisMonitor.unref?.();

  // --- Graceful shutdown ---------------------------------------------------
  // Drain budget — must be < Fly's grace_period (default 30s) minus
  // a safety margin for the post-drain steps (queueClient close,
  // Redis quit, Sentry flush ≈ 3s combined).
  const DRAIN_TIMEOUT_MS = 25_000;
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = Date.now();
    logger.warn(
      { signal, drainTimeoutMs: DRAIN_TIMEOUT_MS },
      '🛑 Shutdown signal received — draining worker'
    );
    try {
      // Race the graceful close against the drain budget. On timeout
      // we force-close: BullMQ marks active jobs as failed and they
      // retry on the next worker boot per their job's retry policy.
      const drainResult = await Promise.race([
        workerClient.close(false).then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)),
      ]);
      if (drainResult === 'timeout') {
        logger.warn(
          { elapsedMs: Date.now() - startedAt },
          '⏱️ Drain budget exceeded — force-closing worker. Active jobs will be marked failed and retried on next boot.'
        );
        await workerClient.close(true).catch((err) => {
          logger.error({ err }, 'Force-close threw');
        });
      } else {
        logger.info({ elapsedMs: Date.now() - startedAt }, '✅ Worker drained cleanly');
      }

      await Container.get(QueueClient).close();
      await publisher.quit();
      await connection.quit();
      await flushSentry(2000);
      logger.info({ totalShutdownMs: Date.now() - startedAt }, '✅ Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err, elapsedMs: Date.now() - startedAt }, '❌ Error during shutdown');
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
