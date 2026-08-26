import { PushSubscriptionRepository } from '@scani/domain/repositories';
import { SendTestNotificationUseCase } from '@scani/domain/use-cases';
import { createComponentLogger } from '@scani/logging';
import { PushSender } from '@scani/push';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const pushLogger = createComponentLogger('router:push');

/**
 * A `PushSubscription.toJSON()`, exactly as the browser produces it.
 *
 * The endpoint has to be an https URL because that is what every push service
 * issues, and because an unvalidated string here is a row we would later hand
 * to an outbound request.
 */
const SubscriptionDto = z.object({
  endpoint: z.string().url().startsWith('https://').max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

/**
 * Web Push subscribe / unsubscribe (SC-226).
 *
 * The whole surface is designed so the client can never end up believing
 * notifications are on when they cannot be:
 *
 * - `status` reports `serverConfigured` separately from `devices`, so the
 *   Settings screen can say "this server cannot send notifications" rather
 *   than rendering a toggle that silently does nothing.
 * - `subscribe` REFUSES when the server has no VAPID keys instead of storing
 *   an endpoint nothing will ever send to.
 */
export const pushRouter = router({
  /**
   * The VAPID application-server key the browser needs, or null.
   *
   * Null rather than `''`: an empty string is the value that reaches
   * `pushManager.subscribe()` and fails inside the browser, where the reason
   * never reaches us.
   */
  publicKey: protectedProcedure.query(() => {
    return { publicKey: Container.get(PushSender).publicKey() };
  }),

  status: protectedProcedure.query(async ({ ctx }) => {
    const devices = await Container.get(PushSubscriptionRepository).countByUser(ctx.userId);
    return { serverConfigured: Container.get(PushSender).isConfigured(), devices };
  }),

  subscribe: protectedProcedure
    .input(
      strictInput(
        z.object({ subscription: SubscriptionDto, userAgent: z.string().max(512).optional() })
      )
    )
    .mutation(async ({ ctx, input }) => {
      if (!Container.get(PushSender).isConfigured()) {
        // Storing it would be the quiet failure: the browser's permission
        // prompt has already been accepted, the row exists, and nothing is
        // ever delivered. Refusing lets the client say why.
        pushLogger.warn(
          { userId: ctx.userId },
          'Refused a push subscription: this deployment has no VAPID keys'
        );
        return { stored: false as const, reason: 'server-not-configured' as const };
      }

      await Container.get(PushSubscriptionRepository).upsert({
        userId: ctx.userId,
        endpoint: input.subscription.endpoint,
        p256dh: input.subscription.keys.p256dh,
        auth: input.subscription.keys.auth,
        userAgent: input.userAgent ?? null,
      });
      return { stored: true as const };
    }),

  /**
   * Forget one endpoint.
   *
   * Scoped to the caller inside the repository, and it reports whether a row
   * actually went — "there was nothing to remove" is a different answer from
   * "removed", and the client uses it to reconcile a browser that thinks it is
   * subscribed against a server that has no record of it.
   */
  unsubscribe: protectedProcedure
    .input(strictInput(z.object({ endpoint: z.string().max(2048) })))
    .mutation(async ({ ctx, input }) => {
      const removed = await Container.get(PushSubscriptionRepository).deleteByEndpoint(
        ctx.userId,
        input.endpoint
      );
      return { removed };
    }),

  /**
   * Send one notification to the CALLER'S OWN devices and report what each
   * endpoint answered (SC-322).
   *
   * Not an admin endpoint on purpose: the person who needs to know whether
   * notifications reach their phone is the person who just turned them on, and
   * routing that through an operator is how a routine check ends up being
   * performed with the VAPID private key on a laptop.
   *
   * A mutation, not a query — it sends, and it prunes any subscription the
   * push service reports as gone.
   */
  test: protectedProcedure.mutation(async ({ ctx }) => {
    return await Container.get(SendTestNotificationUseCase).execute(ctx.userId);
  }),
});
