import 'reflect-metadata';
// CRITICAL: Validate env before importing modules that read process.env.
import { loadEnv } from './config/env';

const env = loadEnv();

import { JOB_NAMES, REPEATABLE_SCHEDULES, SCANI_DLQ, SCANI_QUEUE } from '@scani/queue';
// Import DI-registered modules so Container.get() resolves.
import '@scani/domain/repositories';
import '@scani/domain/services';
import { IntegrationManager } from '@scani/integrations';
import { createComponentLogger } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { initializeRateLimiterRedis } from '@scani/rate-limiter';

// Sentry is the first thing we wire up so boot-time failures are tracked.
initSentry({ component: 'worker', release: env.SENTRY_RELEASE });

import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Container } from 'typedi';
import { apyPayoutsProcessor } from './processors/apy-payouts';
import { exchangeBalancesProcessor } from './processors/exchange-balances';
import { buildExchangeImportProcessor } from './processors/exchange-import';
import { buildFileImportProcessor } from './processors/file-import';
import { buildHoldingPriceUpdateProcessor } from './processors/holding-price-update';
import { pricingProcessor } from './processors/pricing';
import { buildReconcileOrphanedUserJobsProcessor } from './processors/reconcile-orphaned-user-jobs';
import { buildReconcilePendingCredentialsProcessor } from './processors/reconcile-pending-credentials';
import { buildScreenshotParseProcessor } from './processors/screenshot-parse';
import { buildUserDataDeleteProcessor } from './processors/user-data-delete';
import { walletBalancesProcessor } from './processors/wallet-balances';
import { buildWalletImportProcessor } from './processors/wallet-import';

const logger = createComponentLogger('worker');

type Processor = (job: Job) => Promise<unknown>;

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV }, '🚀 Starting Scani worker');

  // DI container setup (same pattern as apps/cron and apps/backend).
  logger.info({}, '✅ DI Container initialized');

  const integrationManager = Container.get(IntegrationManager);
  await integrationManager.initialize();
  logger.info({}, '✅ Integration registry initialized');

  // BullMQ requires maxRetriesPerRequest: null on the ioredis connection it
  // uses for blocking commands (subscribe, bzpopmin, etc.).
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  // Separate publisher connection for WS job events so publishes don't
  // interfere with BullMQ's blocking commands on `connection`.
  const publisher = connection.duplicate();

  // Wire Redis into the rate-limiter module so every `new RateLimiter(...,
  // { namespace })` in integrations + pricing delegates to Redis instead
  // of running an isolated in-memory bucket per worker process.
  initializeRateLimiterRedis(connection);

  const queue = new Queue(SCANI_QUEUE, { connection });
  // Dead-letter queue. Jobs that exhaust retries get copied here so we
  // don't lose the failure context when BullMQ's removeOnFail lattice
  // eventually drops the original job.
  const deadLetterQueue = new Queue(SCANI_DLQ, { connection });

  // Register repeatable jobs so BullMQ fires them on schedule. Using
  // upsertJobScheduler (BullMQ 5.x) is idempotent: redeploys don't create
  // duplicate schedules.
  for (const schedule of REPEATABLE_SCHEDULES) {
    await queue.upsertJobScheduler(
      `scheduler:${schedule.name}`,
      { pattern: schedule.pattern, tz: 'UTC' },
      { name: schedule.name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 500 } }
    );
    logger.info({ name: schedule.name, pattern: schedule.pattern }, '📅 Scheduled repeatable job');
  }

  const PROCESSORS: Record<string, Processor> = {
    // Scheduled jobs (cron).
    [JOB_NAMES.pricing]: pricingProcessor,
    [JOB_NAMES.walletBalances]: walletBalancesProcessor,
    [JOB_NAMES.exchangeBalances]: exchangeBalancesProcessor,
    [JOB_NAMES.apyPayouts]: apyPayoutsProcessor,
    [JOB_NAMES.reconcilePendingCredentials]: buildReconcilePendingCredentialsProcessor(queue),
    [JOB_NAMES.reconcileOrphanedUserJobs]: buildReconcileOrphanedUserJobsProcessor(queue),
    // User-initiated jobs (built with a Redis publisher for WS events).
    [JOB_NAMES.screenshotParse]: buildScreenshotParseProcessor(publisher),
    [JOB_NAMES.exchangeImport]: buildExchangeImportProcessor(publisher),
    [JOB_NAMES.walletImport]: buildWalletImportProcessor(publisher),
    [JOB_NAMES.fileImport]: buildFileImportProcessor(publisher),
    [JOB_NAMES.holdingPriceUpdate]: buildHoldingPriceUpdateProcessor(publisher),
    [JOB_NAMES.userDataDelete]: buildUserDataDeleteProcessor(publisher),
  };

  const worker = new Worker(
    SCANI_QUEUE,
    async (job) => {
      const processor = PROCESSORS[job.name];
      if (!processor) {
        throw new Error(`No processor registered for job '${job.name}'`);
      }
      const start = Date.now();
      logger.info({ jobId: job.id, name: job.name }, '▶️ Processing job');
      const result = await processor(job);
      logger.info(
        { jobId: job.id, name: job.name, durationMs: Date.now() - start },
        '✅ Job completed'
      );
      return result;
    },
    {
      connection: connection.duplicate(),
      concurrency: env.WORKER_CONCURRENCY,
      // drainDelay: previously 30s to cut idle blocking-poll traffic on
      // Upstash's free tier. Dropped to 5s because user-initiated jobs now
      // flow through this queue — a 30s pickup delay on an idle queue
      // would feel like a broken UI. Cost increase: ~6× idle polls, still
      // well within free-tier headroom for current traffic.
      drainDelay: 5,
    }
  );

  worker.on('failed', async (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        error: err instanceof Error ? err.message : String(err),
      },
      '❌ Job failed'
    );
    // Mirror the failure to Sentry with the job name as a tag so dashboards
    // can group by flow (screenshot-parse, wallet-import, exchange-import).
    sentryCapture(err, { jobName: job?.name ?? 'unknown', jobId: String(job?.id ?? 'unknown') });

    // DLQ push on terminal failure (all retry attempts exhausted). Without
    // this, BullMQ's `removeOnFail: 500` eventually truncates the failure
    // and the user-visible evidence is lost.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      try {
        await deadLetterQueue.add(
          job.name,
          {
            originalJobId: job.id,
            originalName: job.name,
            data: job.data,
            failedReason: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            attemptsMade: job.attemptsMade,
            timestamp: Date.now(),
          },
          { removeOnComplete: false, removeOnFail: false }
        );
        logger.warn({ jobId: job.id, name: job.name }, '☠️ Job pushed to DLQ');
      } catch (dlqErr) {
        logger.error({ err: dlqErr }, '⚠️ Failed to write to DLQ');
      }
    }
  });

  // --- Graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, '🛑 Shutdown signal received — draining worker');
    try {
      await worker.close();
      await queue.close();
      await deadLetterQueue.close();
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

  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, queue: SCANI_QUEUE },
    '🎧 Worker listening for jobs'
  );
}

main().catch(async (error) => {
  logger.error({ error }, '💥 Unhandled error in worker');
  sentryCapture(error);
  await flushSentry(2000);
  process.exit(1);
});
