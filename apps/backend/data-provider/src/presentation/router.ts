import { aiRouter } from './routers/ai';
import { chainsRouter } from './routers/chains';
import { contactRouter } from './routers/contact';
import { emailRouter } from './routers/email';
import { keysRouter } from './routers/keys';
import { ogRouter } from './routers/og';
import { pricingRouter } from './routers/pricing';
import { storageRouter } from './routers/storage';
import { tokensRouter } from './routers/tokens';
import { usageRouter } from './routers/usage';
import { waitlistRouter } from './routers/waitlist';
import { router } from './trpc';

export { installCloudDb } from './routers/keys';
export { installUsageDeps } from './routers/usage';
export { installWaitlistCloudDb } from './routers/waitlist';

export const appRouter = router({
  pricing: pricingRouter,
  ai: aiRouter,
  chains: chainsRouter,
  contact: contactRouter,
  email: emailRouter,
  storage: storageRouter,
  og: ogRouter,
  keys: keysRouter,
  tokens: tokensRouter,
  usage: usageRouter,
  waitlist: waitlistRouter,
});

export type AppRouter = typeof appRouter;
