import { OutboxDispatcher } from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { OUTBOX_KICK_CHANNEL } from '@scani/realtime';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';

const log = createComponentLogger('outbox:loop');
const TOUCH_TTL_SECONDS = 8 * 86_400;

/**
 * Counts the dispatcher's database touches in Redis, per UTC day and minute
 * (`outbox:touches:<day>`, field `<HH:MM>:<kind>`, kind `drain:kick`,
 * `drain:sweep` or `prune`), so a day's sweep touches can be checked against
 * the :02/:17/:32/:47 wakes (feeds #23020). Kick drains follow the writers and
 * land off those minutes by design. Read with `redis-cli HGETALL
 * outbox:touches:<day>` on the worker. Best effort: it shares the publisher,
 * whose offline queue is off, so a Redis outage undercounts that day.
 */
function countTouch(redis: Redis, kind: string, at: Date): void {
  const iso = at.toISOString();
  const key = `outbox:touches:${iso.slice(0, 10)}`;
  void redis
    .hincrby(key, `${iso.slice(11, 16)}:${kind}`, 1)
    .then(() => redis.expire(key, TOUCH_TTL_SECONDS))
    .catch(() => undefined);
}

/**
 * Runs the outbox dispatcher for the worker's life (SC-1609). `base` is a
 * connection to the worker's Redis; two duplicates are taken from it: one
 * subscribes to the writers' kicks, one publishes with its offline queue off,
 * so a publish to a dead Redis rejects instead of waiting for a reconnect.
 */
export async function startOutboxDispatchLoop(base: Redis): Promise<{ stop(): Promise<void> }> {
  const kicks = base.duplicate();
  const publisher = base.duplicate({ enableOfflineQueue: false });
  await kicks.subscribe(OUTBOX_KICK_CHANNEL);
  const stopping = new AbortController();
  const loop = Container.get(OutboxDispatcher)
    .run(
      { publish: async (channel, message) => void (await publisher.publish(channel, message)) },
      {
        signal: stopping.signal,
        onTouch: (kind, at) => countTouch(publisher, kind, at),
        kicks: {
          onKick(handler) {
            const listener = (channel: string) => channel === OUTBOX_KICK_CHANNEL && handler();
            kicks.on('message', listener);
            return () => void kicks.off('message', listener);
          },
        },
      }
    )
    .catch((err) => log.error({ err }, 'outbox dispatch loop stopped'));
  return {
    async stop() {
      stopping.abort();
      await loop;
      kicks.disconnect();
      publisher.disconnect();
    },
  };
}
