import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import type { JobEventPayload, JobLifecycleState } from '../core/types';
import { LifecyclePublisher } from './lifecycle-publisher';

const log = createComponentLogger('queue:lifecycle-publisher');

const CHANNEL_PREFIX = 'rt:user:';

/**
 * "Best-effort, continuing" needs the publish to REJECT, and the shared client
 * never does: it is built `maxRetriesPerRequest: null`, so a PUBLISH issued
 * while Redis is down waits for a connection that may not return. Measured on
 * a dead port before this bound (SC-1027): still pending after 4000ms, inside
 * `UserJobProcessor`, which awaits it on every job. 250ms follows the inflow
 * limiter and `PortfolioValueCache`.
 */
const PUBLISH_TIMEOUT_MS = 250;

// Wire shape MUST stay compatible with @scani/realtime's
// RealTimeUpdatesService psubscribe handler — the WS server forwards
// the message to the user's local WS topic without special-casing
// jobs. Don't change the field names without also updating the
// realtime package.
@Service()
export class RedisLifecyclePublisher extends LifecyclePublisher {
  private redis: Redis | null = null;

  configure(redis: Redis): void {
    this.redis = redis;
  }

  override async publish(userId: string, jobId: string, payload: JobEventPayload): Promise<void> {
    if (!this.redis) {
      log.warn({ userId, jobId }, 'RedisLifecyclePublisher not configured — skipping publish');
      return;
    }
    const message = {
      type: 'entity_changed',
      entityType: 'job',
      entityId: jobId,
      operationType: mapStateToOperation(payload.state),
      data: payload,
      timestamp: new Date().toISOString(),
    };
    try {
      await withDeadline(
        Promise.resolve(this.redis.publish(`${CHANNEL_PREFIX}${userId}`, JSON.stringify(message))),
        PUBLISH_TIMEOUT_MS,
        () => new StoreCommandTimeoutError('redis', 'PUBLISH job event', PUBLISH_TIMEOUT_MS)
      );
    } catch (err) {
      log.warn(
        { userId, jobId, error: err instanceof Error ? err.message : String(err) },
        'Failed to publish job event — best-effort, continuing'
      );
    }
  }
}

function mapStateToOperation(state: JobLifecycleState): 'create' | 'update' | 'sync' | 'delete' {
  switch (state) {
    case 'queued':
      return 'create';
    case 'active':
    case 'progress':
      return 'update';
    case 'completed':
      return 'sync';
    case 'failed':
      return 'delete';
  }
}
