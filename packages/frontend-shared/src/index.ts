/**
 * `@scani/frontend-shared`
 *
 * Design system + shared client plumbing for the Scani SPAs (frontendV2 and
 * cloud-frontend). Apps should import from the explicit sub-paths
 * (`@scani/frontend-shared/ui/button` etc.) so individual modules can be
 * tree-shaken — the barrel below is offered as a convenience for dense
 * import sites only.
 */

export { ErrorBoundary } from './components/ErrorBoundary';
export { UpdateBanner } from './components/UpdateBanner';
export { type ResolvedTheme, type Theme, ThemeProvider, useTheme } from './contexts/ThemeContext';
export { useAppUpdate } from './hooks/useAppUpdate';
export { cn } from './lib/cn';
export {
  type CreateAuthClientOptions,
  createScaniAuthClient,
  type ScaniAuthClient,
} from './lib/create-auth-client';
export { createTrpcProvider } from './lib/create-trpc-react';
export * from './lib/pwa-utils';
