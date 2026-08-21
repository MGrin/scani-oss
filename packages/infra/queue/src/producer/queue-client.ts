import { createComponentLogger } from '@scani/logging';
import { createPostgresBackend, type PostgresQueueBackend, Queue } from 'bullmq';

// See the note in worker-client.ts: the backend is a type parameter and the
// default is Redis, so the Postgres variant must be named.
type PgQueue = Queue<any, any, string, any, any, string, PostgresQueueBackend>;

import { Service } from 'typedi';
import { DEFAULT_QUEUE_NAME } from '../core/default-names';

const log = createComponentLogger('queue:client');

export interface QueueClientConfig {
  /** Postgres connection string — the same DATABASE_URL the app already uses. */
  connection: string;
  queueName?: string;
  /**
   * Schema holding BullMQ's tables. Defaults to `bullmq`, which keeps them out
   * of the application's own namespace. Must match what `runQueueMigrations`
   * created, or unqualified queries resolve to nothing.
   */
  schema?: string;
}

export const DEFAULT_QUEUE_SCHEMA = 'bullmq';

// Wraps a single BullMQ Queue. Both api (producer side, enqueueing
// user-initiated jobs) and worker (consumer side, chain-enqueueing
// follow-up jobs + registering repeatable schedules) inject this.
@Service()
export class QueueClient {
  private queue: PgQueue | null = null;

  configure(config: QueueClientConfig): PgQueue {
    if (this.queue) {
      throw new Error('QueueClient already configured — call close() first to reconfigure');
    }
    const name = config.queueName ?? DEFAULT_QUEUE_NAME;
    this.queue = new Queue(
      name,
      {
        connection: {
          connectionString: config.connection,
          schema: config.schema ?? DEFAULT_QUEUE_SCHEMA,
        },
      } as never,
      createPostgresBackend
    );
    log.info({ queue: name, backend: 'postgres' }, '📮 QueueClient configured');
    return this.queue;
  }

  get(): PgQueue {
    if (!this.queue) {
      throw new Error('QueueClient not configured — call configure() at boot');
    }
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}
