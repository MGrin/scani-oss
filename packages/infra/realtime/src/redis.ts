import { createComponentLogger } from '@scani/logging';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import { channelForUser, OUTBOX_KICK_CHANNEL, RealtimeUpdatesService } from './base';

const log = createComponentLogger('realtime:redis');

@Service()
export class RedisRealtimeUpdatesService extends RealtimeUpdatesService {
  private publisher: Redis | null = null;

  configure(publisher: Redis): void {
    this.publisher = publisher;
  }

  /**
   * Best effort, like every broadcast here: a lost kick only delays events
   * until the dispatcher's next sweep, and nothing is lost.
   */
  kickOutbox(): void {
    if (!this.publisher) return;
    void this.publisher.publish(OUTBOX_KICK_CHANNEL, '1').catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'outbox kick dropped');
    });
  }

  protected deliver(userId: string, payload: string): void {
    if (!this.publisher) {
      log.warn({ userId }, 'redis publisher not configured; dropping broadcast');
      return;
    }
    void this.publisher.publish(channelForUser(userId), payload).catch((err) => {
      log.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'redis publish failed; broadcast dropped'
      );
    });
  }
}
