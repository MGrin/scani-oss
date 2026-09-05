import { createComponentLogger } from '@scani/logging';
import { createPostgresBackend, type PostgresQueueBackend, Queue } from 'bullmq';

// See the note in worker-client.ts: the backend is a type parameter and the
// default is Redis, so the Postgres variant must be named.
type PgQueue = Queue<any, any, string, any, any, string, PostgresQueueBackend>;

import { Service } from 'typedi';
import { DEFAULT_DLQ_NAME, DEFAULT_QUEUE_NAME } from '../core/default-names';

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
  private dlq: PgQueue | null = null;
  private config: QueueClientConfig | null = null;

  configure(config: QueueClientConfig): PgQueue {
    if (this.queue) {
      throw new Error('QueueClient already configured — call close() first to reconfigure');
    }
    const name = config.queueName ?? DEFAULT_QUEUE_NAME;
    this.config = config;
    this.queue = this.open(name);
    log.info({ queue: name, backend: 'postgres' }, '📮 QueueClient configured');
    return this.queue;
  }

  private open(name: string): PgQueue {
    // biome-ignore lint/style/noNonNullAssertion: only reachable after `config` is set
    const config = this.config!;
    return new Queue(
      name,
      {
        connection: {
          connectionString: config.connection,
          schema: config.schema ?? DEFAULT_QUEUE_SCHEMA,
        },
      } as never,
      createPostgresBackend
    );
  }

  get(): PgQueue {
    if (!this.queue) {
      throw new Error('QueueClient not configured — call configure() at boot');
    }
    return this.queue;
  }

  /**
   * The dead-letter queue, on the same connection, opened on first use.
   *
   * The api is a producer and never runs a `WorkerClient`, so it has no
   * other handle on `scani-dlq` — and replaying an entry has to go
   * through BullMQ's own state machine rather than hand-written SQL:
   * a job spans several tables in the `bullmq` schema and recomputing
   * that by hand is exactly what `admin-jobs.ts` refuses to do for the
   * main queue.
   *
   * Lazy rather than opened in `configure()` because only the admin
   * replay route wants it; the worker builds its own inside
   * `WorkerClient`. `close()` closes whichever were opened.
   */
  getDlq(): PgQueue {
    if (!this.config) {
      throw new Error('QueueClient not configured — call configure() at boot');
    }
    if (!this.dlq) {
      const name = DEFAULT_DLQ_NAME;
      this.dlq = this.open(name);
      log.info({ queue: name, backend: 'postgres' }, '📮 DLQ handle opened');
    }
    return this.dlq;
  }

  async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    if (this.dlq) {
      await this.dlq.close();
      this.dlq = null;
    }
    this.config = null;
  }
}
