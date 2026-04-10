# Scani Development Guidelines

## Before Pushing

Always run these checks before pushing to main:

```bash
# Type check (all packages)
bun run type-check

# Lint (frontend)
cd apps/frontendV2 && npx @biomejs/biome check src/

# Tests (all packages)  
bun test --preload ./packages/core/test-preload.ts packages/ --timeout 30000
```

## Key Commands

- `bun run type-check` — runs tsgo --noEmit across all 6 packages
- `bun test --preload ./packages/core/test-preload.ts packages/ --timeout 30000` — runs all unit tests
- `cd apps/frontendV2 && npx @biomejs/biome check src/` — lints frontend code
- `cd apps/frontendV2 && npx vite build` — builds frontend for production

## Architecture

- Monorepo: apps/backend, apps/frontendV2, apps/cron, packages/core, packages/shared, packages/integrations
- Frontend V2 lives at `apps/frontendV2/src/v2/`
- Backend uses tRPC routers at `apps/backend/src/presentation/routers/`
- Core business logic at `packages/core/src/`
- AI providers at `packages/core/src/external-services/ai/`
- File import at `packages/core/src/external-services/file-import/`
