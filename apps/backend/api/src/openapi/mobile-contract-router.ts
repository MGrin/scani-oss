import { systemRouter } from '../presentation/routers/system';
import { router } from '../presentation/trpc';

// The explicit set of procedures exposed to the mobile OpenAPI contract.
// Keys MUST mirror the keys used in appRouter so generated paths match the real
// /trpc endpoints (the drift-guard test enforces this). Grows per-screen in
// Milestone 3 — add the real sub-router/procedure here to expose it to mobile.
export const mobileContractRouter = router({
  system: systemRouter,
});

export type MobileContractRouter = typeof mobileContractRouter;
