// In-process semaphore — N concurrent holders, FIFO wait queue.
// Used by WorkerClient to cap how many scheduled jobs can run in flight
// at once so the hourly cron tide (pricing + wallet-balances +
// exchange-balances all firing at minute 0) doesn't starve user-
// initiated jobs of the global concurrency budget.

export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`Semaphore: capacity must be a positive integer (got ${capacity})`);
    }
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.capacity) {
      this.inFlight += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  // Read-only snapshot for diagnostics.
  stats(): { inFlight: number; capacity: number; queued: number } {
    return { inFlight: this.inFlight, capacity: this.capacity, queued: this.waiters.length };
  }
}
