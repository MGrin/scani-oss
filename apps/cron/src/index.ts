import 'reflect-metadata';
import { captureException, close, flush, initializeSentry } from '@scani/core/lib/sentry';
import { createComponentLogger } from '@scani/core/utils/logger';
import { IntegrationManager } from '@scani/integrations';
import { Container } from 'typedi';

// Import all repositories and services to ensure they're registered with TypeDI
import '@scani/core/repositories';
import '@scani/core/services';

// Import all cron jobs
import { executeExchangeBalancesCronJob } from './jobs/ExchangeBalancesCronJob';
import { executePlaidBalancesCronJob } from './jobs/PlaidBalancesCronJob';
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
  'plaid-balances': {
    name: 'plaid-balances',
    execute: executePlaidBalancesCronJob,
    description: 'Sync Plaid account balances',
  },
  'daily-digest': {
    name: 'daily-digest',
    execute: async () => {
      // For daily digest, we need to initialize Telegram bot service
      // For now, we'll skip this job since it requires Telegram bot integration
      logger.warn({}, '⚠️ Daily digest cron job requires Telegram bot service - skipping for now');
    },
    description: 'Send daily portfolio digest to Telegram users',
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

  // Parse command line arguments
  const { tasks } = parseArgs();

  // Validate tasks
  if (tasks.length === 0) {
    logger.error(
      {
        availableTasks: Object.keys(AVAILABLE_JOBS),
      },
      '❌ No tasks specified. Use --tasks=task1,task2,...'
    );
    process.exit(1);
  }

  // Validate task names
  const invalidTasks = tasks.filter((task) => !AVAILABLE_JOBS[task]);
  if (invalidTasks.length > 0) {
    logger.error(
      {
        invalidTasks,
        availableTasks: Object.keys(AVAILABLE_JOBS),
      },
      '❌ Invalid task names provided'
    );
    process.exit(1);
  }

  logger.info(
    {
      tasks,
    },
    '📋 Tasks to execute'
  );

  // Initialize container
  initializeContainer();

  // Initialize integration registry
  try {
    const integrationManager = Container.get(IntegrationManager);
    await integrationManager.initialize();
    logger.info({}, '✅ Integration registry initialized');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '⚠️ Failed to initialize integration registry - some integrations may not work'
    );
    // Exit with error code since integration registry is critical
    process.exit(1);
  }

  // Initialize Sentry for error tracking
  initializeSentry();

  // Execute tasks sequentially
  const results: Array<{ task: string; success: boolean; error?: string; durationMs: number }> = [];

  for (const taskName of tasks) {
    const job = AVAILABLE_JOBS[taskName];
    if (!job) {
      throw new Error(`No job found for task ${taskName}`);
    }
    const taskStartTime = Date.now();

    logger.info(
      {
        task: taskName,
        description: job.description,
      },
      '▶️ Starting task'
    );

    try {
      await job.execute();
      const durationMs = Date.now() - taskStartTime;
      results.push({ task: taskName, success: true, durationMs });

      logger.info(
        {
          task: taskName,
          durationMs,
        },
        '✅ Task completed successfully'
      );
    } catch (error) {
      const durationMs = Date.now() - taskStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      results.push({ task: taskName, success: false, error: errorMessage, durationMs });

      logger.error(
        {
          task: taskName,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          durationMs,
        },
        '❌ Task failed'
      );

      // Capture exception in Sentry
      captureException(error instanceof Error ? error : new Error(errorMessage), {
        task: taskName,
        durationMs,
      });
    }
  }

  // Summary
  const totalDurationMs = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  logger.info(
    {
      totalTasks: results.length,
      successCount,
      failureCount,
      totalDurationMs,
      results,
    },
    '🏁 Cron job execution completed'
  );

  // Flush Sentry events
  await flush(2000);
  await close(2000);

  // Exit with error code if any task failed
  if (failureCount > 0) {
    process.exit(1);
  }

  process.exit(0);
}

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
  captureException(error, {
    type: 'uncaughtException',
    fatal: true,
  });

  logger.fatal(
    {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    },
    '💀 Uncaught Exception - shutting down'
  );

  await flush(2000);
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));

  captureException(error, {
    type: 'unhandledRejection',
    promise: promise.toString(),
    fatal: true,
  });

  logger.fatal(
    {
      reason,
      promise: promise.toString(),
    },
    '💀 Unhandled Promise Rejection - shutting down'
  );

  await flush(2000);
  process.exit(1);
});

// Run main function
main().catch(async (error) => {
  logger.fatal(
    {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    '💀 Fatal error in main - shutting down'
  );

  captureException(error instanceof Error ? error : new Error(String(error)), {
    context: 'main',
    fatal: true,
  });

  await flush(2000);
  process.exit(1);
});
