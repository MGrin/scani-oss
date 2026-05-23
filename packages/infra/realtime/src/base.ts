// Pure value types shared across transports. EntityType is a closed union
// for now to keep router call sites typed; if the package starts being used
// outside this product, widen to `string` and let callers maintain their
// own enum.
export type EntityType =
  | 'institution'
  | 'account'
  | 'holding'
  | 'transaction'
  | 'user'
  | 'token'
  | 'schedule'
  | 'schedule_step'
  | 'group'
  | 'vault'
  | 'job';

export type OperationType = 'create' | 'update' | 'delete' | 'sync';

export interface RealTimeEvent {
  entityType: EntityType;
  operationType: OperationType;
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
  userId: string;
  timestamp: Date;
  metadata?: {
    source?: string;
    relatedEntities?: Array<{ type: EntityType; id: string }>;
  } & Record<string, unknown>;
}

export const REDIS_CHANNEL_PREFIX = 'rt:user:';
export const REDIS_CHANNEL_PATTERN = `${REDIS_CHANNEL_PREFIX}*`;

export function channelForUser(userId: string): string {
  return `${REDIS_CHANNEL_PREFIX}${userId}`;
}

export function userIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(REDIS_CHANNEL_PREFIX)) return null;
  const userId = channel.slice(REDIS_CHANNEL_PREFIX.length);
  return userId.length > 0 ? userId : null;
}

export abstract class RealtimeUpdatesService {
  broadcast(event: Omit<RealTimeEvent, 'timestamp'> & { timestamp?: Date }): void {
    const full: RealTimeEvent = { ...event, timestamp: event.timestamp ?? new Date() };
    this.deliver(full.userId, this.serialize(full));
  }

  broadcastBulk(args: {
    entityType: EntityType;
    operationType: OperationType;
    entityIds: string[];
    userId: string;
    metadata?: RealTimeEvent['metadata'];
  }): void {
    this.broadcast({
      entityType: args.entityType,
      operationType: args.operationType,
      entityIds: args.entityIds,
      userId: args.userId,
      metadata: args.metadata,
    });
  }

  protected serialize(event: RealTimeEvent): string {
    return JSON.stringify({
      type: 'entity_changed',
      entityType: event.entityType,
      entityId: event.entityId,
      entityIds: event.entityIds,
      operationType: event.operationType,
      data: event.data,
      timestamp: event.timestamp.toISOString(),
      metadata: event.metadata,
    });
  }

  protected abstract deliver(userId: string, payload: string): void;
}
