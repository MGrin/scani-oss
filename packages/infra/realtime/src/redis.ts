import { createComponentLogger } from '@scani/logging';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import { channelForUser, RealtimeUpdatesService } from './base';

const log = createComponentLogger('realtime:redis');

@Service()
export class RedisRealtimeUpdatesService extends RealtimeUpdatesService {
  private publisher: Redis | null = null;

  configure(publisher: Redis): void {
    this.publisher = publisher;
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
