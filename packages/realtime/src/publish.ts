/**
 * Worker-side analogue of `emitEntityChange` from
 * `apps/backend/src/infrastructure/websocket/RealTimeUpdatesService.ts`.
 *
 * The worker is a separate process — it can't call `Container.get()` on the
 * backend's `RealTimeUpdatesService`. Instead, it publishes directly to the
 * same Redis pub/sub channel (`rt:user:<userId>`) that the backend's
 * subscriber forwards to connected WebSocket clients.
 *
 * Kept in the worker (not in `@scani/domain`) because the helper takes a
 * concrete ioredis `Redis` instance, and `packages/core` has no runtime
 * ioredis dependency.
 */

import { createComponentLogger } from '@scani/logging';
import type { Redis } from 'ioredis';

const logger = createComponentLogger('worker:emit');

type OperationType = 'create' | 'update' | 'delete' | 'sync';

export interface EntityEventInput {
  entityType: string;
  operationType: OperationType;
  entityId?: string;
  entityIds?: string[];
  userId: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const CHANNEL_PREFIX = 'rt:user:';

export async function emitEntityChangeFromWorker(
  publisher: Redis,
  event: EntityEventInput
): Promise<void> {
  const message = {
    type: 'entity_changed',
    entityType: event.entityType,
    entityId: event.entityId,
    entityIds: event.entityIds,
    operationType: event.operationType,
    data: event.data,
    timestamp: new Date().toISOString(),
    metadata: event.metadata,
  };
  try {
    await publisher.publish(`${CHANNEL_PREFIX}${event.userId}`, JSON.stringify(message));
  } catch (err) {
    logger.warn(
      {
        entityType: event.entityType,
        userId: event.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish entity change — best-effort, continuing'
    );
  }
}
