import 'reflect-metadata';
// CRITICAL: Validate env before importing modules that read process.env.
import { loadEnv } from './config/env';

const env = loadEnv();

import { createComponentLogger } from '@scani/core/utils/logger';
import { IntegrationManager } from '@scani/integrations';
import { Container } from 'typedi';

// Import all repositories and services to ensure they're registered with TypeDI
import '@scani/core/repositories';
import '@scani/core/services';

// Import all cron jobs
import { executeApyPayoutsCronJob } from './jobs/ApyPayoutsCronJob';
import { executeExchangeBalancesCronJob } from './jobs/ExchangeBalancesCronJob';
import { executePricingCronJob } from './jobs/PricingCronJob';
import { executeWalletBalancesCronJob } from './jobs/WalletBalancesCronJob';
import { withJobLock } from './lib/cron-lock';

const logger = createComponentLogger('cron:main');

/**
 * Initialize the Dependency Injection Container
 */
function initializeContainer(): void {
  logger.info(
    {},
    '✅ DI Container initialized with all services and repositories from @scani/core'
  );
}

/**
 * Available cron jobs mapping
 */
const AVAILABLE_JOBS: Record<
  string,
  {
    name: string;
    execute: () => Promise<void>;
    description: string;
  }
> = {
  pricing: {
    name: 'pricing',
    execute: executePricingCronJob,
    description: 'Update token prices for all tokens with holdings',
  },
  'wallet-balances': {
    name: 'wallet-balances',
    execute: executeWalletBalancesCronJob,
    description: 'Sync wallet balances from blockchain',
  },
  'exchange-balances': {
    name: 'exchange-balances',
    execute: executeExchangeBalancesCronJob,
    description: 'Sync exchange balances from exchanges',
  },
  'apy-payouts': {
    name: 'apy-payouts',
    execute: executeApyPayoutsCronJob,
    description: 'Apply APY interest payouts to configured holdings',
  },
};

/**
 * Parse command line arguments
 */
function parseArgs(): { tasks: string[] } {
  const args = process.argv.slice(2);
  let tasks: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--tasks=')) {
      const taskList = arg.substring('--tasks='.length);
      tasks = taskList.split(',').map((t) => t.trim());
    }
  }

  return { tasks };
}

// --- Graceful shutdown support ---------------------------------------------
// Render can send SIGTERM mid-job during redeploys. We flip a flag so the
// outer loop stops launching new tasks, and we await the current task (with a
// hard cap) before exiting. This prevents torn transactions and duplicate
// work when the container is restarted during a sync.
let shuttingDown = false;
let currentJob: Promise<unknown> | null = null;
const SHUTDOWN_HARD_CAP_MS = 30_000;

function installShutdownHandlers(): void {
  const handle = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, '🛑 Shutdown signal received — will exit after current job drains');

    if (!currentJob) {
      process.exit(0);
      return;
    }

    const timer = setTimeout(() => {
      logger.error(
        { capMs: SHUTDOWN_HARD_CAP_MS },
        '⏱️ Drain cap reached — forcing exit (in-flight job may be incomplete)'
      );
      process.exit(1);
    }, SHUTDOWN_HARD_CAP_MS);
    timer.unref?.();

    try {
      await currentJob;
      logger.info({}, '✅ In-flight job drained cleanly');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, '❌ In-flight job failed during drain');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void handle('SIGTERM'));
  process.on('SIGINT', () => void handle('SIGINT'));
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  logger.info(
    {
      nodeEnv: env.NODE_ENV,
    },
    '🚀 Starting Scani Cron Job Runner'
  );

  installShutdownHandlers();

  // Initialize DI Container
  initializeContainer();

  // Initialize IntegrationManager
  const integrationManager = Container.get(IntegrationManager);
  await integrationManager.initialize();

  // Parse command line arguments
  const { tasks } = parseArgs();

  // If no tasks specified, show available tasks
  if (tasks.length === 0) {
    logger.info({}, 'Available cron jobs:');
    for (const [key, job] of Object.entries(AVAILABLE_JOBS)) {
      logger.info({ name: key }, `  ${key}: ${job.description}`);
    }
    logger.info({}, '\nUsage: bun run src/index.ts --tasks=pricing,wallet-balances');
    process.exit(0);
  }

  logger.info({ tasks }, `Executing ${tasks.length} cron job(s)`);

  // Execute each task. Each task is isolated from the others — one failure
  // no longer aborts subsequent tasks (e.g. a pricing API outage must not
  // stop wallet balance sync).
  const results: Array<{ task: string; success: boolean; skipped?: boolean; error?: Error }> = [];

  for (const taskName of tasks) {
    if (shuttingDown) {
      logger.warn({ taskName }, 'Skipping job — shutdown in progress');
      break;
    }

    const job = AVAILABLE_JOBS[taskName];

    if (!job) {
      logger.error({ taskName }, `Unknown cron job: ${taskName}`);
      results.push({
        task: taskName,
        success: false,
        error: new Error(`Unknown cron job: ${taskName}`),
      });
      continue;
    }

    try {
      logger.info({ taskName }, `Executing ${taskName}...`);
      // Wrap execution in a distributed advisory lock so two overlapping
      // cron containers cannot run the same job concurrently.
      const jobPromise = withJobLock(`cron:${taskName}`, () => job.execute());
      currentJob = jobPromise;
      const outcome = await jobPromise;
      if (outcome.ran) {
        results.push({ task: taskName, success: true });
      } else {
        results.push({ task: taskName, success: true, skipped: true });
      }
    } catch (error) {
      logger.error({ taskName, error }, `Failed to execute ${taskName}`);
      results.push({
        task: taskName,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      currentJob = null;
    }
  }

  // Summary
  const totalDuration = Date.now() - startTime;
  const successful = results.filter((r) => r.success && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info(
    {
      total: results.length,
      successful,
      skipped,
      failed,
      duration: `${totalDuration}ms`,
    },
    '✨ Cron job execution completed'
  );

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run main function
main().catch((error) => {
  logger.error({ error }, '💥 Unhandled error in cron job runner');
  process.exit(1);
});
