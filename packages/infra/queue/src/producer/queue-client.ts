import { createComponentLogger } from '@scani/logging';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import { DEFAULT_QUEUE_NAME } from '../core/default-names';

const log = createComponentLogger('queue:client');

export interface QueueClientConfig {
  connection: Redis;
  queueName?: string;
}

// Wraps a single BullMQ Queue. Both api (producer side, enqueueing
// user-initiated jobs) and worker (consumer side, chain-enqueueing
// follow-up jobs + registering repeatable schedules) inject this.
@Service()
export class QueueClient {
  private queue: Queue | null = null;

  configure(config: QueueClientConfig): Queue {
    if (this.queue) {
      throw new Error('QueueClient already configured — call close() first to reconfigure');
    }
    const name = config.queueName ?? DEFAULT_QUEUE_NAME;
    this.queue = new Queue(name, { connection: config.connection });
    log.info({ queue: name }, '📮 QueueClient configured');
    return this.queue;
  }

  get(): Queue {
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
