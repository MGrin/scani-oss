import { Container } from 'typedi';
import type { EntityType, OperationType, RealTimeEvent } from './base';
import { RedisRealtimeUpdatesService } from './redis';

export {
  channelForUser,
  type EntityType,
  type OperationType,
  REDIS_CHANNEL_PATTERN,
  REDIS_CHANNEL_PREFIX,
  type RealTimeEvent,
  RealtimeUpdatesService,
  userIdFromChannel,
} from './base';
export { RedisRealtimeUpdatesService } from './redis';
export { type ClientConnection, WebSocketRealtimeUpdatesService } from './websocket';

// Convenience helpers for code that doesn't want to grab the service
// directly. Both go through the Redis transport so emissions reach every
// backend instance, including the local one (its own pipeFromRedis fans
// the message back to local WS clients).
export function emitEntityChange(event: Omit<RealTimeEvent, 'timestamp'>): void {
  Container.get(RedisRealtimeUpdatesService).broadcast(event);
}

export function emitBulkEntityChanges(
  entityType: EntityType,
  operationType: OperationType,
  entityIds: string[],
  userId: string,
  metadata?: RealTimeEvent['metadata']
): void {
  Container.get(RedisRealtimeUpdatesService).broadcastBulk({
    entityType,
    operationType,
    entityIds,
    userId,
    metadata,
  });
}
