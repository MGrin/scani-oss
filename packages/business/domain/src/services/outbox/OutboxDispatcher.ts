import { withAdvisoryLock } from '@scani/db';
import { withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import { channelForUser } from '@scani/realtime';
import { OUTBOX_MESSAGE_TYPE, type OutboxMessage } from '@scani/shared';
import { Container, Service } from 'typedi';
import {
  OutboxEventRepository,
  type UnpublishedOutboxEvent,
} from '../../repositories/OutboxEventRepository';

const log = createComponentLogger('outbox:dispatcher');

/** An awaited publish: it resolves only once the message is out, and throws otherwise. */
export interface OutboxPublisher {
  publish(channel: string, message: string): Promise<void>;
}

/** Notifies the dispatcher that a write committed. Returns an unsubscribe. */
export interface OutboxKickSource {
  onKick(handler: () => void): () => void;
}

export interface DispatchOutcome {
  /** Rows read this pass; 0 means the outbox is empty. */
  read: number;
  published: number;
  /** A publish failed: the rest of the pass stays unpublished for the next one. */
  failed: boolean;
}

const LOCK_KEY = 'outbox-dispatcher';
const BATCH_SIZE = 100;
// A client that was away longer than this refetches instead of replaying.
const KEEP_PUBLISHED_MS = 7 * 86_400_000;
const PRUNE_BATCH = 1_000;
// A publish to a dead Redis does not reject on its own: ioredis queues the
// command and waits for a reconnect, which would hold the loop indefinitely.
const PUBLISH_TIMEOUT_MS = 2_000;

function envelope(row: UnpublishedOutboxEvent): string {
  const message: OutboxMessage = {
    type: OUTBOX_MESSAGE_TYPE,
    id: String(row.id),
    event: row.type as OutboxMessage['event'],
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
  return JSON.stringify(message);
}

const QUARTER_MS = 15 * 60_000;
const SWEEP_OFFSET_MS = 2 * 60_000;

/**
 * The next :02, :17, :32 or :47, strictly after `now`. The sweep rides the
 * wake the quarter-hour probes already cause (SC-1601); a timer counted from
 * boot would land between them and wake Neon on its own.
 */
export function nextQuarterSweep(now: Date): Date {
  const t = now.getTime() - SWEEP_OFFSET_MS;
  return new Date((Math.floor(t / QUARTER_MS) + 1) * QUARTER_MS + SWEEP_OFFSET_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Copies committed outbox rows to their owner's realtime channel, oldest
 * first (SC-1609, feeds foundation §5). Delivery is at-least-once: a row is
 * marked published only after its publish resolved, so a crash between the
 * two sends it again with the same id, which is how a client drops a repeat.
 */
@Service()
export class OutboxDispatcher {
  private readonly repository = Container.get(OutboxEventRepository);

  /** One pass. The caller must be the only live dispatcher: `run` takes the lock for it. */
  async dispatchBatch(publisher: OutboxPublisher): Promise<DispatchOutcome> {
    const rows = await this.repository.findUnpublished(BATCH_SIZE);
    const done: number[] = [];
    let published = 0;
    let failed = false;
    for (const row of rows) {
      if (!row.userId) {
        // No owner, so no channel to copy it to. The writer refuses these;
        // marking one stops it from being re-read on every pass.
        log.warn({ id: row.id, type: row.type }, 'outbox row with no user; not published');
        done.push(row.id);
        continue;
      }
      try {
        await withDeadline(
          publisher.publish(channelForUser(row.userId), envelope(row)),
          PUBLISH_TIMEOUT_MS,
          () => new Error(`outbox publish timed out after ${PUBLISH_TIMEOUT_MS}ms`)
        );
      } catch (err) {
        log.warn(
          { id: row.id, err: err instanceof Error ? err.message : String(err) },
          'outbox publish failed; the row stays for the next pass'
        );
        failed = true;
        break;
      }
      done.push(row.id);
      published += 1;
    }
    await this.repository.markPublished(done);
    return { read: rows.length, published, failed };
  }

  /**
   * The worker loop. It touches the database only when told to: on a kick from
   * a committed write, and at each quarter-hour sweep for kicks that were lost.
   * Idle, it holds no connection and runs no query, so Neon can scale to zero.
   *
   * The advisory lock is taken per drain, never held between them. A
   * dispatcher that finds it taken skips the drain: the holder heard the same
   * kick and drains until the outbox reads empty. A failed pass backs off
   * exponentially and retries, so an outage loses nothing.
   */
  async run(
    publisher: OutboxPublisher,
    options: {
      signal: AbortSignal;
      kicks: OutboxKickSource;
      nextSweepAt?: (now: Date) => Date;
      maxBackoffMs?: number;
      /** Called before each database touch, so a day's touches can be counted by minute. */
      onTouch?: (kind: 'drain:kick' | 'drain:sweep' | 'prune', at: Date) => void;
    }
  ): Promise<void> {
    const {
      signal,
      kicks,
      nextSweepAt = nextQuarterSweep,
      maxBackoffMs = 30_000,
      onTouch = () => {},
    } = options;
    let wake: (() => void) | null = null;
    let kicked = false;
    const unsubscribe = kicks.onKick(() => {
      kicked = true;
      wake?.();
    });
    const untilKickOrSweep = () =>
      new Promise<void>((resolve) => {
        if (kicked || signal.aborted) return resolve();
        const timer = setTimeout(done, Math.max(0, nextSweepAt(new Date()).getTime() - Date.now()));
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          wake = null;
          resolve();
        }
        wake = done;
        signal.addEventListener('abort', done, { once: true });
      });
    try {
      while (!signal.aborted) {
        await untilKickOrSweep();
        if (signal.aborted) break;
        const swept = !kicked;
        kicked = false;
        onTouch(swept ? 'drain:sweep' : 'drain:kick', new Date());
        await withAdvisoryLock(LOCK_KEY, async () => {
          await this.drain(publisher, signal, maxBackoffMs);
          if (swept) {
            onTouch('prune', new Date());
            await this.prune();
          }
        });
      }
    } finally {
      unsubscribe();
    }
  }

  /** On the sweep's wake, so it adds none: published rows older than a week go. */
  private async prune(): Promise<void> {
    try {
      await this.repository.prunePublished(new Date(Date.now() - KEEP_PUBLISHED_MS), PRUNE_BATCH);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'outbox prune failed');
    }
  }

  /**
   * Publishes until the outbox is empty. A failed pass backs off and retries,
   * but only up to the cap: past it the drain returns and releases the lock,
   * so an outage does not hold a reserved connection (SC-1613). The next kick
   * or sweep tries again; the rows wait.
   */
  private async drain(
    publisher: OutboxPublisher,
    signal: AbortSignal,
    maxBackoffMs: number
  ): Promise<void> {
    let backoff = 250;
    while (!signal.aborted) {
      let outcome: DispatchOutcome;
      try {
        outcome = await this.dispatchBatch(publisher);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'outbox pass failed');
        outcome = { read: 0, published: 0, failed: true };
      }
      if (outcome.failed) {
        if (backoff > maxBackoffMs) {
          log.warn('outbox drain gave up at the backoff cap; the next kick or sweep retries');
          return;
        }
        await sleep(backoff, signal);
        backoff *= 2;
        continue;
      }
      if (outcome.read === 0) return;
    }
  }
}
