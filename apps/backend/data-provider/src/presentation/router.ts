import { aiRouter } from './routers/ai';
import { chainsRouter } from './routers/chains';
import { emailRouter } from './routers/email';
import { keysRouter } from './routers/keys';
import { ogRouter } from './routers/og';
import { pricingRouter } from './routers/pricing';
import { storageRouter } from './routers/storage';
import { tokensRouter } from './routers/tokens';
import { usageRouter } from './routers/usage';
import { router } from './trpc';

export { installCloudDb } from './routers/keys';
export { installUsageDeps } from './routers/usage';

export const appRouter = router({
  pricing: pricingRouter,
  ai: aiRouter,
  chains: chainsRouter,
  email: emailRouter,
  storage: storageRouter,
  og: ogRouter,
  keys: keysRouter,
  tokens: tokensRouter,
  usage: usageRouter,
});

export type AppRouter = typeof appRouter;
