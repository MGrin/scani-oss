import 'reflect-metadata';
import { createComponentLogger } from '@scani/core/utils/logger';
import { IntegrationManager } from '@scani/integrations';
import { Container } from 'typedi';

// Import all repositories and services to ensure they're registered with TypeDI
import '@scani/core/repositories';
import '@scani/core/services';

// Import all cron jobs
import { executeExchangeBalancesCronJob } from './jobs/ExchangeBalancesCronJob';
import { executePricingCronJob } from './jobs/PricingCronJob';
import { executeWalletBalancesCronJob } from './jobs/WalletBalancesCronJob';

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

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  logger.info(
    {
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    '🚀 Starting Scani Cron Job Runner'
  );

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

  // Execute each task
  const results: Array<{ task: string; success: boolean; error?: Error }> = [];

  for (const taskName of tasks) {
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
      await job.execute();
      results.push({ task: taskName, success: true });
    } catch (error) {
      logger.error({ taskName, error }, `Failed to execute ${taskName}`);
      results.push({
        task: taskName,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Summary
  const totalDuration = Date.now() - startTime;
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info(
    {
      total: results.length,
      successful,
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
