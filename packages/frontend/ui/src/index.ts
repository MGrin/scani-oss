/**
 * `@scani/ui`
 *
 * Design system + shared client plumbing for the Scani SPAs (frontend/app
 * and frontend/cloud). Apps should import from the explicit sub-paths
 * (`@scani/ui/ui/button`, `@scani/ui/contexts/ThemeContext`, …) so
 * individual modules can be tree-shaken — the barrel below is offered as
 * a convenience for dense import sites only.
 *
 * apps/frontend/app is the canonical source of truth: when promoting a
 * new shared primitive, copy from there.
 */
export { ErrorBoundary } from './components/ErrorBoundary';
export { InstallPromptBanner } from './components/InstallPromptBanner';
export { ThemeToggle } from './components/ThemeToggle';
export { UpdateBanner } from './components/UpdateBanner';
export { ThemeProvider } from './contexts/ThemeContext';
export { assertFrontendEnv } from './lib/assert-frontend-env';
export { createTrpcProvider } from './lib/create-trpc-react';
export * from './lib/pwa-utils';
