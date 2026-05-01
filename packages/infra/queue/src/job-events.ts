/**
 * Worker-side helper to publish job state updates over the same Redis
 * pub/sub channel that `RealTimeUpdatesService` (apps/backend) uses to
 * fan out entity changes to WebSocket clients.
 *
 * The message format mirrors what `RealTimeUpdatesService.broadcast()`
 * produces, so the backend's inbound psubscribe handler forwards it to the
 * user's local WS topic without needing special-case logic for jobs.
 *
 * The channel pattern is `rt:user:<userId>` — see
 * `apps/backend/src/infrastructure/websocket/RealTimeUpdatesService.ts`.
 *
 * We accept a Redis instance as a parameter so `packages/core` stays free of
 * a direct `ioredis` runtime dependency; callers (backend, worker) already
 * have one. The `RedisLike` type is a structural subset of ioredis `Redis`.
 */

export type JobLifecycleState = 'queued' | 'active' | 'progress' | 'completed' | 'failed';

export interface JobEventPayload {
  state: JobLifecycleState;
  progress?: number;
  result?: unknown;
  error?: string;
  attemptsMade?: number;
  attemptsAllowed?: number;
}

interface RedisLike {
  publish(channel: string, message: string): Promise<number> | number;
}

const CHANNEL_PREFIX = 'rt:user:';

/**
 * Publish a job lifecycle event for the given user. Non-throwing: WS
 * delivery is best-effort. If the publish fails, worker logs and continues
 * — the authoritative job state is already in BullMQ.
 */
export async function publishJobEvent(
  redis: RedisLike,
  userId: string,
  jobId: string,
  payload: JobEventPayload
): Promise<void> {
  const operationType = mapStateToOperation(payload.state);
  const message = {
    type: 'entity_changed',
    entityType: 'job',
    entityId: jobId,
    operationType,
    data: payload,
    timestamp: new Date().toISOString(),
  };
  const channel = `${CHANNEL_PREFIX}${userId}`;
  await Promise.resolve(redis.publish(channel, JSON.stringify(message)));
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
