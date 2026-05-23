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

export { ConfirmDialog } from './components/ConfirmDialog';
export { EmptyState } from './components/EmptyState';
export { ErrorBoundary } from './components/ErrorBoundary';
export { FaviconImg } from './components/FaviconImg';
export {
  InstallPromptBanner,
  type InstallPromptBannerProps,
} from './components/InstallPromptBanner';
export { MagicCodeInput } from './components/MagicCodeInput';
export { PullToRefresh } from './components/PullToRefresh';
export { ThemeToggle, type ThemeToggleProps } from './components/ThemeToggle';
export { UpdateBanner } from './components/UpdateBanner';
export { type ResolvedTheme, type Theme, ThemeProvider, useTheme } from './contexts/ThemeContext';
export { useAppUpdate } from './hooks/useAppUpdate';
export { useDebouncedValue } from './hooks/useDebouncedValue';
export { type UseInstallPromptResult, useInstallPrompt } from './hooks/useInstallPrompt';
export {
  type AssertFrontendEnvOptions,
  assertFrontendEnv,
  type FrontendEnvSpec,
} from './lib/assert-frontend-env';
export { cn } from './lib/cn';
export {
  type CreateAuthClientOptions,
  createScaniAuthClient,
  type ScaniAuthClient,
} from './lib/create-auth-client';
export { createTrpcProvider } from './lib/create-trpc-react';
export * from './lib/pwa-utils';
