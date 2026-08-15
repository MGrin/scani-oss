# @scani/ui

Design system + shared client plumbing for the Scani SPAs (`apps/frontend/app`,
`apps/frontend/cloud`, and any future React app). Anything that should look
or behave the same across our apps lives here.

## What's inside

### Tailwind preset + tokens

- `tailwind-preset` — extends Tailwind with our color tokens, typography,
  keyframes, and container settings. App-side `tailwind.config.js` extends
  this as `presets: [sharedPreset]`.
- `styles/globals.css` — light/dark theme CSS variables (HSL tokens). Apps
  `@import '@scani/ui/styles/globals.css'` from their `index.css`.

### shadcn primitive set (`./ui/<name>`)

Full set of headless-by-default Radix wrappers, all using the same `cn()`
helper:

| Module                | Backing primitive                         |
| --------------------- | ----------------------------------------- |
| `alert`               | none (cva variants)                       |
| `badge`               | none (cva variants)                       |
| `button`              | `@radix-ui/react-slot` + cva              |
| `card`                | none                                      |
| `checkbox`            | `@radix-ui/react-checkbox`                |
| `command`             | `cmdk`                                    |
| `dialog`              | `@radix-ui/react-dialog`                  |
| `input`               | none                                      |
| `label`               | `@radix-ui/react-label`                   |
| `loading`             | none — spinner / dots / overlay variants  |
| `popover`             | `@radix-ui/react-popover`                 |
| `progress`            | `@radix-ui/react-progress`                |
| `select`              | `@radix-ui/react-select`                  |
| `separator`           | `@radix-ui/react-separator`               |
| `sheet`               | `@radix-ui/react-dialog`                  |
| `skeleton`            | none                                      |
| `table`               | none                                      |
| `textarea`            | none                                      |
| `toast` / `toaster`   | `@radix-ui/react-toast`                   |
| `tooltip`             | `@radix-ui/react-tooltip`                 |
| `use-toast`           | imperative toast hook                     |

### React primitives (`./components/<name>`, `./contexts/...`, `./hooks/...`)

| Export                                        | What it does                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `ErrorBoundary`                               | App-level boundary with optional `onError` Sentry hook + home link     |
| `UpdateBanner` + `useAppUpdate`               | Service-worker version polling + a banner that prompts a reload        |
| `MagicCodeInput`                              | 6-digit OTP input with autofocus, paste, resend                        |
| `EmptyState`                                  | Icon + title + description + action layout                             |
| `ConfirmDialog`                               | Standard confirm/cancel modal with pending state                       |
| `FaviconImg`                                  | Image with letter-fallback on load failure                             |
| `PullToRefresh`                               | iOS PWA-only pull-to-refresh gesture (no-op outside PWA mode)          |
| `ThemeProvider` / `useTheme`                  | light/dark/system theme with configurable `storageKey`                 |
| `useDebouncedValue<T>(value, ms)`             | Debounce a value for filter/search inputs                              |

### Lib (`./lib/<name>`)

- `cn(...inputs)` — `clsx` + `tailwind-merge`. The atom every primitive
  composes against.
- `pwa-utils` — `isPWA`, `isStandalone`, `getPlatform` (ios/android/desktop),
  `supportsDeepLinking`, plus `localStorage`-backed PWA-auth-token helpers.
- `create-auth-client` — factory that wraps `better-auth/react`'s
  `createAuthClient` with the magic-link plugin pre-wired.
- `create-trpc-react` — factory returning a `<TrpcProvider>` component
  bound to `@trpc/react-query` + a `QueryClient` with sensible defaults.

## Source-of-truth rule

`apps/frontend/app` is canonical. When you find yourself promoting a new
primitive into this package, **copy from `app` first**, then delete the
app-side copy and rewrite imports. Don't divergently re-implement — if
the app and the shared package drift, we lose the design-system
guarantee.

When app and shared have already drifted (it happens during a refactor
window), a quick `diff -u` against the app version tells you which
direction to merge. Generally take app's presentational changes (button
variants, card padding, color tweaks) and keep shared's infra
flexibility (configurable storageKey, optional onError hooks, etc.).

## Adding a new shared primitive

1. Confirm the candidate is generic (no domain types, no app-specific
   env vars, no `react-router-dom` or other app-only dependency).
2. `git mv` the file from `apps/frontend/app/src/components/<X>.tsx` →
   `packages/frontend/ui/src/components/<X>.tsx`.
3. Rewrite its imports:
   - `from '@/lib/utils'` → `from '../lib/cn'`
   - `from '@/components/ui/<y>'` → `from '../ui/<y>'`
   - `from '@scani/ui/...'` → relative path within the package
4. Add an entry to `package.json` `exports` and to `src/index.ts` barrel.
5. Update every consumer in the app to `from '@scani/ui/components/<X>'`.
6. Run `bun --cwd packages/frontend/ui run type-check` and the app's
   type-check.
7. If the primitive is browser-DOM-bound (uses `window`, `document`,
   React effects), no test is required. If it's a pure helper, add a
   `tests/<sub>/<name>.test.ts` mirroring the source path.

## Imports in apps

Prefer the explicit sub-path so individual modules stay tree-shakeable:

```ts
import { Button } from '@scani/ui/ui/button';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { useDebouncedValue } from '@scani/ui/hooks/useDebouncedValue';
import { isPWA } from '@scani/ui/lib/pwa-utils';
```

The barrel `@scani/ui` is offered as a convenience for dense import
sites only.

## Tailwind setup

Each consuming app's `tailwind.config.js`:

```js
import sharedPreset from '@scani/ui/tailwind-preset';

export default {
  presets: [sharedPreset],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../../packages/frontend/ui/src/**/*.{ts,tsx}',
  ],
};
```

Each app's `index.css` should `@import '@scani/ui/styles/globals.css';`
once at the top so the design tokens land in scope before any utility
class is applied.

## Tests

`bun test packages/frontend/ui --timeout 30000`

Pure helpers (`cn`, `pwa-utils` user-agent detection) are unit-tested.
DOM-bound modules (Theme, components, hooks) are exercised in the apps'
own browser smoke tests — there's no React testing infra in the
monorepo and adding it would dwarf the value for this package's surface.

## Why this package exists

Without it, every Scani SPA reinvents the same shadcn primitives, the
same theme provider, the same PWA helpers. We've already paid the
copy-paste cost once; this package is how we stop paying it. The
trade-off is a small extra round-trip when adding a one-off primitive
that turns out *not* to need sharing — in that case keep it in the app.
