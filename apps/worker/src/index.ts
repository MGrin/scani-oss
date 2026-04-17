import 'reflect-metadata';
// CRITICAL: Validate env before importing modules that read process.env.
import { loadEnv } from './config/env';

const env = loadEnv();

import { JOB_NAMES, REPEATABLE_SCHEDULES, SCANI_QUEUE } from '@scani/core/queues';
import { executeApyPayoutsCronJob } from '@scani/cron/jobs/apy-payouts';
import { executeExchangeBalancesCronJob } from '@scani/cron/jobs/exchange-balances';
import { executePricingCronJob } from '@scani/cron/jobs/pricing';
import { executeWalletBalancesCronJob } from '@scani/cron/jobs/wallet-balances';
// Import DI-registered modules so Container.get() resolves.
import '@scani/core/repositories';
import '@scani/core/services';
import { createComponentLogger } from '@scani/core/utils/logger';
import { IntegrationManager } from '@scani/integrations';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Container } from 'typedi';

const logger = createComponentLogger('worker');

type Processor = (job: Job) => Promise<void>;

const PROCESSORS: Record<string, Processor> = {
  [JOB_NAMES.pricing]: async () => executePricingCronJob(),
  [JOB_NAMES.walletBalances]: async () => executeWalletBalancesCronJob(),
  [JOB_NAMES.exchangeBalances]: async () => executeExchangeBalancesCronJob(),
  [JOB_NAMES.apyPayouts]: async () => executeApyPayoutsCronJob(),
  // wallet-import and exchange-sync are on-demand placeholders — the backend
  // will enqueue them as part of R2's request-handler refactor. For now the
  // processors are no-ops that log an info so we can see them wired.
  [JOB_NAMES.walletImport]: async (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'wallet-import job received (TODO: implement)');
  },
  [JOB_NAMES.exchangeSync]: async (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'exchange-sync job received (TODO: implement)');
  },
};

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

  const queue = new Queue(SCANI_QUEUE, { connection });

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

  const worker = new Worker(
    SCANI_QUEUE,
    async (job) => {
      const processor = PROCESSORS[job.name];
      if (!processor) {
        throw new Error(`No processor registered for job '${job.name}'`);
      }
      const start = Date.now();
      logger.info({ jobId: job.id, name: job.name }, '▶️ Processing job');
      await processor(job);
      logger.info(
        { jobId: job.id, name: job.name, durationMs: Date.now() - start },
        '✅ Job completed'
      );
    },
    {
      connection: connection.duplicate(),
      concurrency: env.WORKER_CONCURRENCY,
      // Block on an empty queue for 30s instead of the BullMQ default of 5s.
      // This cuts idle blocking-poll traffic 6× — critical on Upstash's
      // 500k commands/month free tier. Trade-off: a newly-enqueued job
      // waits up to 30s for pickup when the queue was empty. Nothing
      // user-facing runs synchronously through BullMQ, so fine.
      drainDelay: 30,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        error: err instanceof Error ? err.message : String(err),
      },
      '❌ Job failed'
    );
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
      await connection.quit();
      logger.info({}, '✅ Worker drained cleanly');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, '❌ Error during shutdown');
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

main().catch((error) => {
  logger.error({ error }, '💥 Unhandled error in worker');
  process.exit(1);
});
