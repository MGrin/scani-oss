import { createComponentLogger, logConfig } from '@scani/logging';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import {
  type EntityType,
  REDIS_CHANNEL_PATTERN,
  RealtimeUpdatesService,
  userIdFromChannel,
} from './base';

const log = createComponentLogger('realtime:websocket');

const STALE_CONNECTION_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const REQUIRED_SERVICE_NAME = 'scani-backend';

export interface ClientConnection {
  id: string;
  userId: string;
  subscriptions: Set<EntityType>;
  lastSeen: Date;
}

interface RegisterConnectionOptions {
  userId: string;
  connectionId?: string;
  initialSubscriptions?: EntityType[];
}

// Elysia's `Elysia` type carries a deep generic chain; this package depends
// only on `app.server.publish(topic, payload)`. Narrow to that one call.
// biome-ignore lint/suspicious/noExplicitAny: structural-only access on a third-party app instance.
type ElysiaLike = { server?: { publish: (topic: string, payload: string) => any } | null } | null;

@Service()
export class WebSocketRealtimeUpdatesService extends RealtimeUpdatesService {
  // The transport guard used to live in the constructor but typedi's
  // class-field DI lazily constructs services on first Container.get,
  // and that timing isn't deterministic relative to env loading. The
  // old guard fired ~50 spurious Sentry events on backend boot
  // (SERVICE_NAME='<unset>' even though fly.toml set it). The check
  // is now in the api-only entry points (setElysiaApp / initialize /
  // pipeFromRedis); construction itself is inert.
  private clients = new Map<string, ClientConnection>();
  private userConnections = new Map<string, Set<string>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private elysiaApp: ElysiaLike = null;

  private assertInBackend(method: string): void {
    if (process.env.SERVICE_NAME !== REQUIRED_SERVICE_NAME) {
      throw new Error(
        `WebSocketRealtimeUpdatesService.${method}() called in SERVICE_NAME='${process.env.SERVICE_NAME ?? '<unset>'}' ` +
          `(expected '${REQUIRED_SERVICE_NAME}'). Use RedisRealtimeUpdatesService for cross-process broadcasts.`
      );
    }
  }

  // Accept anything that exposes `server.publish` — typically an Elysia
  // instance, but the package doesn't depend on Elysia's types.
  setElysiaApp(app: unknown): void {
    this.assertInBackend('setElysiaApp');
    this.elysiaApp = app as ElysiaLike;
  }

  initialize(): void {
    this.assertInBackend('initialize');
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.cleanupStaleConnections(), HEARTBEAT_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.clients.clear();
    this.userConnections.clear();
    this.elysiaApp = null;
  }

  // Notify every connected client that the server is going away so the
  // SPA can show a clean reconnect prompt instead of treating the abrupt
  // socket close as a network error. Caller is responsible for waiting
  // briefly (~500ms) for the publish to flush over the wire before
  // tearing the HTTP server down.
  broadcastShutdown(reconnectInMs = 1000): { recipients: number } {
    if (!this.elysiaApp?.server) return { recipients: 0 };
    const payload = JSON.stringify({
      type: 'server_shutdown',
      reconnectInMs,
      timestamp: new Date().toISOString(),
    });
    let recipients = 0;
    for (const userId of this.userConnections.keys()) {
      this.elysiaApp.server.publish(`user:${userId}`, payload);
      recipients += 1;
    }
    return { recipients };
  }

  // Subscribe to the shared `rt:user:*` Redis channel and forward inbound
  // payloads to local WS clients. This is the fan-in side that lets a
  // worker (or another api machine) reach this machine's WS subscribers.
  pipeFromRedis(subscriber: Redis): void {
    this.assertInBackend('pipeFromRedis');
    void subscriber.psubscribe(REDIS_CHANNEL_PATTERN, (err) => {
      if (err) {
        log.error(
          { err: err.message, pattern: REDIS_CHANNEL_PATTERN },
          'psubscribe to realtime channel failed'
        );
      }
    });
    subscriber.on('pmessage', (_pattern, channel, payload) => {
      const userId = userIdFromChannel(channel);
      if (!userId) return;
      this.deliverLocal(userId, payload);
    });
  }

  registerConnection(options: RegisterConnectionOptions): string {
    const connectionId = options.connectionId ?? `conn_${crypto.randomUUID()}`;
    const subscriptions = new Set<EntityType>(
      options.initialSubscriptions?.length
        ? options.initialSubscriptions
        : ['institution', 'account', 'holding', 'transaction', 'token']
    );

    this.clients.set(connectionId, {
      id: connectionId,
      userId: options.userId,
      subscriptions,
      lastSeen: new Date(),
    });

    let userConns = this.userConnections.get(options.userId);
    if (!userConns) {
      userConns = new Set();
      this.userConnections.set(options.userId, userConns);
    }
    userConns.add(connectionId);

    return connectionId;
  }

  handleMessage(connectionId: string, data: unknown): void {
    const client = this.clients.get(connectionId);
    if (!client) return;

    try {
      // Bun/Elysia auto-parses JSON frames, so `data` may already be an
      // object. Tolerate strings (older shims) and Buffers (raw frames).
      const message =
        typeof data === 'object' && data !== null && !(data instanceof Buffer)
          ? (data as Record<string, unknown>)
          : JSON.parse(typeof data === 'string' ? data : String(data));
      client.lastSeen = new Date();

      switch (message.type) {
        case 'subscribe': {
          const types = (message.entityTypes as EntityType[] | undefined) ?? [];
          for (const t of types) client.subscriptions.add(t);
          this.sendToUser(
            client.userId,
            JSON.stringify({
              type: 'subscription_updated',
              subscriptions: Array.from(client.subscriptions),
              timestamp: new Date().toISOString(),
            })
          );
          break;
        }
        case 'unsubscribe': {
          const types = (message.entityTypes as EntityType[] | undefined) ?? [];
          for (const t of types) client.subscriptions.delete(t);
          this.sendToUser(
            client.userId,
            JSON.stringify({
              type: 'subscription_updated',
              subscriptions: Array.from(client.subscriptions),
              timestamp: new Date().toISOString(),
            })
          );
          break;
        }
        case 'ping':
          this.sendToUser(
            client.userId,
            JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() })
          );
          break;
        default:
          if (logConfig.logWebSocketMessages) {
            log.warn({ connectionId, messageType: message.type }, 'unknown WebSocket message type');
          }
      }
    } catch (err) {
      log.error(
        { connectionId, err: err instanceof Error ? err.message : String(err) },
        'failed to handle WebSocket message'
      );
    }
  }

  handleDisconnection(connectionId: string): void {
    const client = this.clients.get(connectionId);
    if (!client) return;

    const userConns = this.userConnections.get(client.userId);
    if (userConns) {
      userConns.delete(connectionId);
      if (userConns.size === 0) this.userConnections.delete(client.userId);
    }
    this.clients.delete(connectionId);
  }

  // Single-recipient send for messages that don't fan out (pong,
  // subscription_updated). Cross-instance broadcasts go through
  // RedisRealtimeUpdatesService; this stays purely local.
  sendToUser(userId: string, payload: string): void {
    this.deliverLocal(userId, payload);
  }

  getStats() {
    return {
      totalConnections: this.clients.size,
      totalUsers: this.userConnections.size,
      connectionsByUser: Array.from(this.userConnections.entries()).map(
        ([userId, connections]) => ({
          userId,
          connectionCount: connections.size,
        })
      ),
    };
  }

  protected deliver(userId: string, payload: string): void {
    this.deliverLocal(userId, payload);
  }

  private deliverLocal(userId: string, payload: string): void {
    if (!this.elysiaApp?.server) {
      if (logConfig.logWebSocketMessages) {
        log.warn({ userId }, 'elysia app not registered; dropping local deliver');
      }
      return;
    }
    this.elysiaApp.server.publish(`user:${userId}`, payload);
  }

  private cleanupStaleConnections(): void {
    const now = Date.now();
    for (const [connectionId, client] of this.clients) {
      if (now - client.lastSeen.getTime() > STALE_CONNECTION_MS) {
        this.handleDisconnection(connectionId);
      }
    }
  }
}
