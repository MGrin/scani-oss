# @scani/realtime

Cross-process realtime entity-change events. Backend services (api, worker)
publish to a shared Redis channel; the api fans the messages out to its
local WebSocket clients.

## Architecture

```
                   broadcast(event)
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
 ┌──────────────────────────────┐   ┌──────────────────────────────┐
 │ RedisRealtimeUpdatesService  │   │ RedisRealtimeUpdatesService  │
 │       (worker process)       │   │       (api process)          │
 └────────────┬─────────────────┘   └────────────┬─────────────────┘
              │                                  │
              ▼                                  ▼
        Redis pub/sub channel  rt:user:<userId>
              │                                  │
              ▼                                  ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  api machine A                  │  api machine B                 │
 │  WebSocketRealtimeUpdates      │  WebSocketRealtimeUpdates      │
 │     .pipeFromRedis()           │     .pipeFromRedis()           │
 │       ↓                        │       ↓                        │
 │     local WS topic             │     local WS topic             │
 │       ↓                        │       ↓                        │
 │  browsers connected here       │  browsers connected here       │
 └──────────────────────────────────────────────────────────────────┘
```

Workers/cron never touch WebSockets — they only publish to Redis. Each
api machine owns its own WebSocket topic and subscribes to the Redis
channel to receive both worker events and other api machines' events.

## What's exported

| Export | Purpose |
|---|---|
| `RealtimeUpdatesService` (abstract) | Common base. Implements `broadcast(event)` and `broadcastBulk(args)`. Subclasses provide `deliver(userId, payload)`. |
| `RedisRealtimeUpdatesService` | Publishes serialized events to `rt:user:<userId>` via an injected `ioredis` publisher. Used by every process that emits. |
| `WebSocketRealtimeUpdatesService` | Owns local connection bookkeeping (registerConnection / handleMessage / handleDisconnection / heartbeat) and forwards Redis-piped messages to local WS clients via `setElysiaApp(app)`. **Constructor throws if `SERVICE_NAME !== 'api'`** — only the api process should hold WS state. |
| `RealTimeEvent`, `EntityType`, `OperationType`, `ClientConnection` | Domain types. |
| `emitEntityChange(event)` | Helper. Resolves `RedisRealtimeUpdatesService` from typedi and calls `broadcast`. The most common entry point — used by routers and worker processors. |
| `emitBulkEntityChanges(...)` | Helper for the multi-id case. |
| `channelForUser`, `userIdFromChannel`, `REDIS_CHANNEL_PREFIX`, `REDIS_CHANNEL_PATTERN` | Wire-format helpers, exported for tests / debugging. |

## Usage

### Routers / processors — emit a change

```ts
import { emitEntityChange } from '@scani/realtime';

emitEntityChange({
  entityType: 'holding',
  operationType: 'update',
  entityId: holding.id,
  userId: user.id,
  data: { quantity: holding.quantity },
});
```

This goes via Redis, so every api instance (including the originating
one) gets the message and forwards to its own WS clients.

### Worker boot — wire the publisher

```ts
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { Container } from 'typedi';
import { Redis } from 'ioredis';

const publisher = redisConnection.duplicate();
Container.get(RedisRealtimeUpdatesService).configure(publisher);
```

After this, any `emitEntityChange(...)` call from a processor reaches WS
clients on every api machine.

### API boot — own the WS state, pipe from Redis

```ts
import {
  RedisRealtimeUpdatesService,
  WebSocketRealtimeUpdatesService,
} from '@scani/realtime';
import { Container } from 'typedi';

const ws = Container.get(WebSocketRealtimeUpdatesService);
ws.setElysiaApp(app);
ws.initialize();

Container.get(RedisRealtimeUpdatesService).configure(redisConnection);
ws.pipeFromRedis(redisConnection.duplicate());
```

The `.duplicate()` is required: ioredis can't multiplex pub/sub and
regular commands on the same socket.

### API WebSocket handlers — bookkeeping

```ts
const ws = Container.get(WebSocketRealtimeUpdatesService);

// On open
ws.registerConnection({ userId, connectionId });

// On incoming frame
ws.handleMessage(connectionId, frame);

// On close
ws.handleDisconnection(connectionId);
```

For local-only sends that shouldn't fan out across instances (e.g. a
`pong` reply), use `ws.sendToUser(userId, payload)` directly.

## The SERVICE_NAME guard

`WebSocketRealtimeUpdatesService` throws on construction if
`process.env.SERVICE_NAME !== 'api'`. Connection state has no
meaning outside the process that holds the sockets — instantiating this
service in a worker would silently swallow events that should have gone
through the Redis transport. Failing fast at startup catches the wiring
mistake at deploy time, not after a user notices missing updates.

## Wire format

Every published payload is a JSON string of:

```ts
{
  type: 'entity_changed',
  entityType: string,
  entityId?: string,
  entityIds?: string[],
  operationType: 'create' | 'update' | 'delete' | 'sync',
  data?: object,
  timestamp: string,    // ISO-8601
  metadata?: object,
}
```

Channel name: `rt:user:<userId>`. The frontend client parses based on
`type` (currently always `entity_changed`; `pong` and
`subscription_updated` come from `WebSocketRealtimeUpdatesService.sendToUser`
out-of-band).
