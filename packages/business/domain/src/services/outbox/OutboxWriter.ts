import type { DatabaseTransaction } from '@scani/db';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { OUTBOX_EVENT_SCHEMAS, type OutboxEventPayload, type OutboxEventType } from '@scani/shared';
import { Container, Service } from 'typedi';
import { OutboxEventRepository } from '../../repositories/OutboxEventRepository';

/**
 * Appends a live event in the caller's transaction (SC-1609), so the event
 * exists exactly when the data it describes does: a rollback takes both.
 *
 * Every event has an owner. A price change is appended once per affected user
 * with that user's holdings, never as one shared row, so a user's channel
 * never carries another user's ids.
 */
@Service()
export class OutboxWriter {
  private readonly repository = Container.get(OutboxEventRepository);

  async append<T extends OutboxEventType>(
    tx: DatabaseTransaction,
    userId: string,
    type: T,
    payload: OutboxEventPayload<T>
  ): Promise<number> {
    if (!userId) throw new Error(`Outbox event ${type} has no user: every event has an owner`);
    const parsed = OUTBOX_EVENT_SCHEMAS[type].parse(payload);
    return this.repository.insert(tx, { userId, type, payload: parsed });
  }

  /**
   * Tells the dispatcher to drain. Call it after the transaction that
   * appended has COMMITTED: a kick sent earlier finds nothing to read, and
   * the event then waits for the next sweep. Best effort; a lost kick costs
   * latency, never an event.
   */
  kick(): void {
    Container.get(RedisRealtimeUpdatesService).kickOutbox();
  }
}
