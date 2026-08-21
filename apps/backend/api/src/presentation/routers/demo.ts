import { demoIdentity } from '@scani/domain/demo';
import { DEMO_RESET_SCHEDULE } from '@scani/jobs';
import { loadDemoConfig } from '../../config/demo';
import { publicProcedure, router } from '../trpc';

/**
 * What the frontend needs to know about the deployment it is talking to
 * (SC-466).
 *
 * Public and unauthenticated because it is what decides whether the app asks
 * for a session at all. On every deployment but the demo it answers
 * `{ enabled: false }` and the app behaves exactly as it did before — which is
 * why the demo banner and the demo gate ship in one bundle and light up only
 * where the server says so. A build-time flag would put the same decision in
 * the artefact, where `app.scani.xyz` could be handed the wrong one.
 *
 * Nothing here reads the database. The identity is derived (see
 * `demoIdentity`), so this answers correctly during the seconds a scheduled
 * reset has the persona's row deleted — the window in which a database-backed
 * answer would bounce a visitor to the sign-in screen.
 */
export const demoRouter = router({
  status: publicProcedure.query(() => {
    const config = loadDemoConfig();
    if (!config.enabled) {
      return { enabled: false as const };
    }
    const identity = demoIdentity();
    return {
      enabled: true as const,
      user: { id: identity.id, email: identity.email, name: identity.name },
      signupUrl: config.signupUrl,
      /** UTC cron of the reset, so the banner can say when the data goes back. */
      resetCron: DEMO_RESET_SCHEDULE.cron,
    };
  }),
});
