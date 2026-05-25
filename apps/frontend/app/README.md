# @scani/frontend-v2 (apps/frontend/app)

React + Vite SPA for **[Scani](https://github.com/MGrin/scani-oss)** — the
self-hostable, open-source portfolio tracker for crypto and traditional
assets. tRPC end-to-end with `@scani/backend`; Better-Auth for sessions;
[shadcn/ui](https://ui.shadcn.com) on Tailwind, sourced from
[`@scani/ui`](../../../packages/frontend/ui/).

## Local dev

```sh
# From the repo root: full stack in compose (recommended)
bun run dev:stack            # http://localhost:5173

# Or just this app on the host (infra still in compose):
docker compose up -d postgres redis mailpit minio
bun install
bun dev                      # this app on :5173 + api on :3001 concurrently
```

`VITE_API_URL` (e.g. `http://localhost:3011` in dev compose, `/api` in
prod) points the Better-Auth client + tRPC client at the backend.

## Build

```sh
bun run build                # → dist/
bun run preview              # serve the production build locally
```

The published Docker image (`scani/frontend-app`) bakes
`VITE_API_URL=/api` so the bundled SPA always speaks to the same origin
through nginx. The nginx reverse proxy and runtime config live in
[`Dockerfile`](./Dockerfile) and [`nginx.conf.template`](./nginx.conf.template).

## Layout

- `src/v2/components/` — feature components (current generation).
- `src/v2/hooks/` — feature hooks.
- `src/components/` — legacy + shared components shared with v2.
- `src/contexts/` — React contexts (`AuthContext` over Better-Auth's
  client, `ThemeContext`, `RealtimeContext` for SSE).
- `src/lib/auth-client.ts` — Better-Auth client (magic-link + email-OTP plugins).
- `src/i18n/locales/` — translation JSON files. Drop a new file in here
  to add a language (no other code changes); see
  [`locales/CONTRIBUTORS.md`](./src/i18n/locales/CONTRIBUTORS.md).
- `public/` + `scripts/generate-icons.js` — PWA manifest, service worker,
  generated icons.

## Auth

Magic-link + email-OTP via [Better-Auth](https://better-auth.com),
delivered through the api's `/api/auth/*` mount. In a PWA install
context the client switches to OTP because clicking a link in a
mail-app opens a new browser context that breaks the session — the
desktop / mobile-web flows stay on magic-link. See
[`src/contexts/AuthContext.tsx`](./src/contexts/AuthContext.tsx).

## tRPC

The SPA imports the api router type for end-to-end inference:

```ts
import type { AppRouter } from '@scani/backend';
import { createTRPCReact } from '@trpc/react-query';
export const trpc = createTRPCReact<AppRouter>();
```

Server-state lives in React Query (TanStack Query) via the tRPC
adapter. Wire DTOs are zod schemas in `@scani/shared`.

## Styling

Tailwind preset + `globals.css` ship from
[`@scani/ui`](../../../packages/frontend/ui/). Primitives (button,
card, dialog, …) are imported from `@scani/ui/ui/*`. Conditional class
composition uses `cn()` from `@scani/ui/lib/utils`. See the
[`@scani/ui` README](../../../packages/frontend/ui/README.md) for the
full primitive list.

## More

Architecture, deployment, and full env-var reference live in
[`apps/frontend/docs/`](../docs/) and on
[docs.scani.xyz](https://docs.scani.xyz).
