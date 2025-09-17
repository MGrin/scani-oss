# Copilot Instructions - Scani Finance SaaS

## Architecture Overview

**Scani** is a TypeScript monorepo personal finance SaaS built with tRPC, Drizzle ORM, and Bun. The architecture follows a strict separation between frontend (React + Vite) and backend (Elysia + tRPC) with shared type definitions.

### Key Architecture Patterns

- **Monorepo Structure**: `apps/backend` (tRPC API), `apps/frontend` (React SPA), `packages/shared` (common types/utils)
- **End-to-End Type Safety**: All API communication uses tRPC with shared TypeScript types from `@scani/backend/router`
- **Database**: PostgreSQL with Drizzle ORM, dynamic enums stored in database tables (not TypeScript enums)
- **Authentication**: Supabase Auth with JWT tokens, user sync to local PostgreSQL via `middleware/auth.ts`

## Development Workflows

### Essential Commands

```bash
# Development (from root)
bun dev                    # Start both frontend + backend with hot reload
bun run db:migrate         # Apply database migrations
bun run db:studio          # Open Drizzle Studio for DB management

# Backend-specific (from apps/backend/)
bun dev:verbose           # Enable SQL query logging + WebSocket debugging
bun run db:generate       # Generate migrations after schema changes

# Testing
bun test                  # Run all tests (93%+ coverage maintained)
bun test --coverage       # Generate coverage report
```

### Environment Setup

- **Backend**: Requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`
- **Frontend**: Requires `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- **Database**: PostgreSQL (all envs) - use Supabase DB or local instance

## Project-Specific Conventions

### Authentication Pattern

- All protected routes use `protectedProcedure` from `apps/backend/src/trpc.ts`
- User authentication via Supabase, but user data stored in local `users` table
- Auth context provides `{ user, isAuthenticated, dbUser }` with automatic sync

### Database Schema Design

- **Dynamic Enums**: Institution types, account types, transaction types, token types stored as database tables (not TS enums)
- **UUID Primary Keys**: All entities use UUID with `defaultRandom()`
- **User Scoping**: All user data automatically filtered by authenticated user ID
- **Financial Precision**: Use `Decimal.js` for all monetary calculations

### tRPC Router Structure

```typescript
// All routers follow this pattern in apps/backend/src/routers/
export const entityRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx); // Auto user scoping
    // ...query with user filter
  }),
  create: protectedProcedure
    .input(CreateSchema)
    .mutation(async ({ input, ctx }) => {
      // ...validation and creation
    }),
});
```

### Frontend tRPC Usage

```tsx
// Import from backend router for type safety
import { trpc } from "@/lib/trpc";

// All queries auto-include authentication headers
const { data: accounts } = trpc.accounts.getAll.useQuery();
const createAccount = trpc.accounts.create.useMutation();
```

### Service Layer Pattern

- Business logic in `apps/backend/src/services/` (pricing, portfolio-valuation, user-context)
- Services handle complex operations like price fetching (Finnhub API), portfolio calculations
- Real-time updates via WebSocket for live price updates

## Key Files to Understand

- `apps/backend/src/db/schema.ts` - Complete database schema with relationships
- `packages/shared/src/types/finance.ts` - All validation schemas using Zod
- `apps/backend/src/middleware/auth.ts` - Authentication and user sync logic
- `apps/backend/src/router.ts` - Main tRPC router assembly
- `apps/frontend/src/lib/trpc-provider.tsx` - Frontend tRPC client setup

## Critical Integration Points

- Always use `bun` and `bunx` commands.
- Use Drizzle ORM for all database interactions, never raw SQL.
- Use `Decimal.js` for all financial calculations to avoid floating-point errors.
- All API calls must go through tRPC procedures, never direct REST or GraphQL calls.
- Ensure all financials calculations are done on the backend for security and consistency.

### Database Migrations

- Schema changes require `bun run db:generate`
- Always use Drizzle ORM syntax, never raw SQL for schema
- Database migrations will be applied by user only, never auto-apply them

### Financial Data Handling

- All monetary values use `Decimal.js` for precision
- Price data from external APIs (Finnhub, CoinGecko) cached in `tokenPrices` table
- Portfolio calculations in `services/portfolio-valuation.ts`

### Testing Requirements

- No tests are required
- You can create testing scripts if needed, but then you must remove them before final submission

## Anti-Patterns to Avoid

- Never use TypeScript enums for dynamic data (use database tables instead)
- Don't bypass `protectedProcedure` for user-scoped data
- Avoid direct SQL queries (use Drizzle ORM)
- Don't hardcode financial calculations (use `Decimal.js` and shared utilities)
- Never expose sensitive data in frontend - all auth via backend tRPC procedures
- Never use `npm` or `yarn` or `npx` or something else - always use `bun` and `bunx`
