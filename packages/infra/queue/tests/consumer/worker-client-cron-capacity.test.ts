import { expect, test } from 'bun:test';
import { createPostgresBackend, Queue } from 'bullmq';
import { WorkerClient } from '../../src/consumer/worker-client';

async function until(predicate: () => boolean, milliseconds = 1500) {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

// A group step has no cron of its own (SC-1688) and still counts as scheduled
// work: an admin "Run now" of one takes a cron slot, not a user one. A user
// job is told apart by its payload schema.
test.each([
  ['a scheduled job', { name: 'cron', cron: '* * * * *' }],
  ['a group step with no cron', { name: 'cron', lockName: 'cron' }],
])(
  'saturated scheduled work (%s) leaves worker capacity for a user job without spending cron attempts',
  async (_label, cronDescriptor) => {
    const name = `cron-capacity-${crypto.randomUUID()}`;
    const connection = process.env.DATABASE_URL!;
    const queue = new Queue(
      name,
      { connection: { connectionString: connection } } as never,
      createPostgresBackend
    );
    const client = new WorkerClient();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cronStarts = 0;
    let userRan = false;
    client.configure({
      connection,
      queueName: name,
      dlqName: `${name}-dlq`,
      concurrency: 2,
      cronConcurrency: 1,
    });
    client.register({
      descriptor: cronDescriptor,
      process: async () => {
        cronStarts++;
        await held;
      },
    } as never);
    client.register({
      descriptor: { name: 'user', schema: {} },
      process: async () => {
        userRan = true;
      },
    } as never);
    try {
      for (let i = 0; i < 4; i++) await queue.add('cron', {}, { attempts: 1 });
      const worker = await client.start();
      worker.on('error', () => undefined);
      await worker.waitUntilReady();
      await until(() => cronStarts === 1);
      await queue.add('user', {});
      client.wake();
      await until(() => userRan);
      expect(cronStarts).toBe(1);
      const waiting = await queue.getJobs(['delayed']);
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.every((job) => job.attemptsMade === 0)).toBe(true);
      release();
      client.wake();
      await until(() => cronStarts === 4, 10000);
    } finally {
      release();
      await client.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }
);
