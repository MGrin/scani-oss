# Copilot Instructions - Scani Finance SaaS

> **For GitHub Copilot Agents**: These instructions guide automated code changes. Always follow the workflow patterns and security considerations outlined below.

## Quick Reference for Agents

**Essential Commands:**

- `bun dev` - Start all development servers (backend + frontendV2)
- `bun dev:backend` - Start backend only
- `bun dev:frontend` - Start frontendV2 only
- `bun lint:fix` - Run Biome linter and auto-fix all issues (run before every commit)
- `bun lint` - Run Biome linter in check-only mode (no fixes applied)
- `bun type-check` - Run TypeScript checks on all packages
- `cd packages/core && bun run db:generate` - Generate new migrations
- `bun run db:migrate` - Apply database migrations

**Critical Rules:**

- ✅ **ALWAYS run `bun lint:fix` before every `report_progress` commit** — Biome auto-fixes formatting, never commit without it
- ✅ Always use `bun` and `bunx` (never npm/yarn/npx)
- ✅ Use Drizzle ORM for database operations (never raw SQL)
- ✅ All user data must be scoped via `protectedProcedure`
- ✅ Use TypeDI Container for dependency injection
- ✅ **ALWAYS use proper ES6 imports at the top of files** (NEVER use `require()` or dynamic imports)
- ✅ Follow clean architecture - Use Cases → Services → Repositories
- ✅ Follow DRY, OOP, SOLID, and Onion Architecture principles
- ✅ Initialize container before importing routers (see `apps/backend/src/index.ts`)
- ✅ **Render PostgreSQL**: Direct connection with prepared statements enabled
- ❌ **NEVER use `require()` or `await import()` or any dynamic imports** - always use static ES6 imports
- ❌ **NEVER add retry logic for database operations** - if queries fail, there's a fundamental issue
- ❌ **NEVER increase query timeouts** - queries must be fast, system must fail fast
- ❌ Never auto-apply database migrations
- ❌ Never use TypeScript enums for dynamic data
- ❌ Never bypass authentication for user-scoped data
- ❌ Never commit secrets or sensitive data
- ❌ Never instantiate services directly - always use TypeDI Container

## Architecture Overview

**Scani** is a TypeScript monorepo personal finance SaaS built with tRPC, Drizzle ORM, Bun, and TypeDI. The architecture follows clean architecture principles with strict separation of concerns.

### Key Architecture Patterns

- **Monorepo Structure**: `apps/backend` (tRPC API), `apps/worker` (BullMQ consumer), `apps/cron` (scheduled jobs), `apps/frontendV2` (React SPA), `apps/landing` (marketing site), `packages/*` (shared code)
- **End-to-End Type Safety**: All API communication uses tRPC with shared TypeScript types
- **Database**: PostgreSQL with Drizzle ORM, dynamic enums stored in database tables (not TypeScript enums)
- **Authentication**: Supabase Auth with JWT tokens, user sync to local PostgreSQL via middleware
- **Dependency Injection**: TypeDI Container for service management and dependency injection
- **Clean Architecture**: Use Cases → Services → Repositories → Database
- **Real-time Updates**: WebSocket server for live portfolio updates
- **AI Integration**: OpenAI integration for screenshot parsing and chat assistance

### Package Structure

**Packages:**

- `@scani/core` - Core business logic, database, services, use cases, repositories
- `@scani/integrations` - Integration framework (Plaid, Binance, Kraken, etc.)
- `@scani/rate-limiter` - Rate limiting utilities
- `@scani/shared` - Shared types and utilities (Zod schemas, Decimal.js helpers)

**Apps:**

- `@scani/backend` - tRPC API server with Elysia
- `@scani/worker` - BullMQ worker for background jobs
- `@scani/cron` - Standalone cron entry for scheduled jobs
- `@scani/frontend-v2` - React SPA with Vite
- `@scani/landing` - Marketing site (Vite + React)

### Import and Module Guidelines

**CRITICAL: Always use proper ES6 imports, NEVER use dynamic imports**

```typescript
// ✅ CORRECT - Proper ES6 imports at the top of the file
import { IntegrationManager } from "@scani/integrations";
import { db } from "@scani/core/database/connection";
import * as schema from "@scani/core/database/schema";
import { Container } from "typedi";

// ✅ CORRECT - Using TypeDI Container
const service = Container.get(MyService);

// ❌ WRONG - Dynamic require statements
const { IntegrationManager } = require("@scani/integrations");

// ❌ WRONG - Async/dynamic imports
const { IntegrationManager } = await import("@scani/integrations");

// ❌ WRONG - Direct instantiation (bypass DI)
const service = new MyService();
```

### Dependency Injection with TypeDI

**All services must use TypeDI Container for dependency injection**

```typescript
// ✅ CORRECT - Service class with @Service decorator
import { Service } from "typedi";

@Service()
export class MyService {
  constructor(
    private readonly repository: MyRepository,
    private readonly logger: Logger,
  ) {}
}

// ✅ CORRECT - Getting service from container
import { Container } from "typedi";
const service = Container.get(MyService);

// ❌ WRONG - Manual instantiation
const service = new MyService(repository, logger);
```

**Container Initialization:**

- Container MUST be initialized before any service imports
- See `apps/backend/src/config/container.ts` for setup
- Call `initializeContainer()` in `apps/backend/src/index.ts` before imports

### Integration Architecture

**The `@scani/integrations` package manages external service integrations:**

- **IntegrationManager** - Central registry for all integrations
- **Implementations** - Plaid, Binance, Kraken, DefiLlama, Blockchain explorers
- **Services** - Integration-specific API clients
- **Base Classes** - Abstract base classes for integration implementations
- **Rate Limiters** - Per-integration rate limiting configurations

**Integration Pattern:**

```typescript
// ✅ CORRECT - Use IntegrationManager from Container
import { IntegrationManager } from "@scani/integrations";
import { Container } from "typedi";

const manager = Container.get(IntegrationManager);
const integration = manager.getIntegration("binance");

// ✅ CORRECT - Use integration implementations through manager
await integration.validateCredentials({ apiKey, apiSecret });
```

## Development Workflows

### Essential Commands

```bash
# Development (from root)
bun dev                    # Start backend + frontendV2
bun dev:backend            # Start backend only
bun dev:frontend           # Start frontendV2 only
bun dev:cron               # Start cron app (manual trigger)

# Database (from packages/core)
cd packages/core
bun run db:generate        # Generate migrations after schema changes
bun run db:migrate         # Apply migrations
bun run db:studio          # Open Drizzle Studio (database GUI)

# Linting & Type Checking (from root)
bun lint:fix              # Auto-fix all Biome formatting/style issues (ALWAYS run before committing)
bun lint                   # Check-only (no fixes) — verify after lint:fix
bun type-check            # Check TypeScript types
```

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
// All routers follow this pattern in apps/backend/src/presentation/routers/
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

### Clean Architecture with Use Cases

**The project follows clean architecture principles with a dedicated use cases layer:**

- **Use Cases** (`packages/core/src/use-cases/`) - Business logic encapsulation
  - 18 use cases for various business operations
  - Examples: `CreateHoldingUseCase`, `ImportWalletAddressUseCase`, `SyncPlaidBalancesUseCase`
  - Each use case handles a single business operation
  - Reusable across routers, background jobs, and CLI tools
- **Services** (`packages/core/src/services/`) - Infrastructure & external integrations
  - PricingService, PortfolioValuationService, UserContextService
  - Handle complex operations like price fetching and portfolio calculations
  - Manage rate limiting and external API calls
- **Repositories** (`packages/core/src/repositories/`) - Data access layer
  - Clean abstraction over database operations
  - Used by use cases and services for data persistence
  - Examples: `HoldingRepository`, `TokenRepository`, `AccountRepository`
- **Routers** (`apps/backend/src/presentation/routers/`) - Thin controllers
  - Delegate to use cases for business logic
  - Handle HTTP concerns (validation, response formatting)
  - 20+ routers for different domains (accounts, holdings, tokens, etc.)

**Architecture Benefits:**

- Clear separation of concerns
- Improved testability (use cases can be unit tested)
- Better code reusability
- Easier to maintain and scale

## Key Files to Understand

- `packages/core/src/database/schema.ts` - Complete database schema with relationships
- `packages/core/src/use-cases/` - Business logic layer (18 use cases)
- `packages/core/src/use-cases/index.ts` - All use case exports
- `packages/core/src/services/` - Infrastructure services
- `packages/core/src/repositories/` - Data access layer
- `packages/shared/src/index.ts` - Shared validation schemas using Zod
- `apps/backend/src/config/container.ts` - TypeDI container initialization
- `apps/backend/src/presentation/middleware/auth.ts` - Authentication and user sync logic
- `apps/backend/src/presentation/router.ts` - Main tRPC router assembly
- `apps/backend/src/presentation/routers/` - Individual route handlers (thin controllers)
- `apps/frontendV2/src/lib/trpc-provider.tsx` - Frontend tRPC client setup

## Critical Integration Points

- Always use `bun` and `bunx` commands.
- Use Drizzle ORM for all database interactions, never raw SQL.
- Use `Decimal.js` for all financial calculations to avoid floating-point errors.
- All API calls must go through tRPC procedures, never direct REST or GraphQL calls.
- Ensure all financials calculations are done on the backend for security and consistency.

### Database Migrations

**IMPORTANT: Always use Drizzle's migration system properly**

**For Schema Changes (adding/modifying tables, columns):**

1. Edit `packages/core/src/database/schema.ts`
2. Run `cd packages/core && bun run db:generate` to auto-generate migration
3. User applies migration with `bun run db:migrate`

**For Custom SQL Migrations (dropping objects, raw SQL operations):**

1. Create SQL file: `packages/core/src/database/migrations/XXXX_descriptive_name.sql`
   - Use next sequential number (check existing migrations)
2. **MUST register in journal**: Edit `packages/core/src/database/migrations/meta/_journal.json`
   - Add entry with incremented `idx`, current timestamp in `when`, and `tag` matching filename (without .sql)
3. User applies migration with `bun run db:migrate`

**Migration Journal Entry Format:**

```json
{
  "idx": 32,
  "version": "7",
  "when": 1738522200000,
  "tag": "0032_descriptive_name",
  "breakpoints": true
}
```

**Critical Rules:**

- ❌ NEVER create raw SQL files without registering in `_journal.json`
- ❌ NEVER auto-apply migrations - user must run `bun run db:migrate`
- ✅ Always use sequential numbering (check last migration number)
- ✅ Use descriptive names for custom migrations

### Render PostgreSQL Configuration

**Direct PostgreSQL connection (no connection pooler)**

- **Connection Pool Size**: Use `max: 20` (appropriate for direct connections)
  - Render PostgreSQL supports up to 97 connections on standard plans
  - Direct connections allow larger client pools
  - Pool size can be adjusted based on workload
- **Timeouts**: Keep short to fail fast
  - `connect_timeout: 10` seconds (default)
  - Let queries fail naturally if they take too long
- **Enabled Features** (direct connection supports these):
  - `prepare: true` - Prepared statements for faster repeated queries
  - `fetch_types: true` - Proper type handling
- **Never Add Retry Logic**:
  - If database queries fail, there's a fundamental issue
  - Retries hide problems and make debugging harder
  - Fix the root cause, don't mask it with retries

### Financial Data Handling

- All monetary values use `Decimal.js` for precision
- Price data from external APIs (CoinGecko, DefiLlama, blockchain explorers) cached in `tokenPrices` table
- Portfolio calculations in `packages/core/src/services/PortfolioValuationService.ts`

### Testing Requirements

- No tests are required
- You can create testing scripts if needed, but then you must remove them before final submission

## Anti-Patterns to Avoid

### Code Organization and Imports

- ❌ **NEVER use `require()` or `await import()` for dynamic imports** - ALWAYS use proper static ES6 imports at the top of files
- ❌ **NEVER use dynamic imports even for circular dependencies** - restructure code instead
- ❌ **NEVER use lazy loading imports** - use static imports only
- ❌ Never instantiate integration services directly (use factory functions from packages)
- ❌ Never create rate limiters in application code (encapsulate in packages)
- ❌ Never bypass clean architecture principles (follow DRY, OOP, SOLID, Onion Architecture)
- ❌ Never leak implementation details from packages (use factory pattern)

### Data and Type Safety

- ❌ Never use TypeScript enums for dynamic data (use database tables instead)
- ❌ Don't bypass `protectedProcedure` for user-scoped data
- ❌ Avoid direct SQL queries (use Drizzle ORM)
- ❌ Don't hardcode financial calculations (use `Decimal.js` and shared utilities)
- ❌ Never expose sensitive data in frontend - all auth via backend tRPC procedures

### Database Operations

- ❌ **NEVER add retry logic for database queries** - retries hide fundamental issues
- ❌ **NEVER increase query timeouts** - queries must be fast, fail fast
- ❌ Never add exponential backoff or retry mechanisms for database failures
- ❌ If queries fail, investigate the root cause (connection config, network, schema)

### Tooling

- ❌ Never use `npm` or `yarn` or `npx` or something else - always use `bun` and `bunx`

## Documentation Organization

**All documentation files (.md) must follow this structure:**

- **Root README.md**: Project overview and quick start guide (keep in root)
- **Core Documentation**: Only 3 files allowed in `/docs`:
  - `ARCHITECTURE.md` - Technical architecture and design patterns
  - `EXECUTIVE_SUMMARY.md` - Project status and strategic overview
  - `ROADMAP.md` - Development roadmap and feature tracking
- **Detailed Documentation**: All other documentation in `/docs` subfolders:
  - `/docs/features/` - Feature specifications and implementation guides
  - `/docs/technical/` - Technical deep-dives and API documentation
  - `/docs/stability/` - Stability fixes, debugging guides, and analysis reports
  - `/docs/implementation/` - Implementation summaries and batch operation docs
  - `/docs/backend-fixes/` - Backend-specific bug fixes and patches
  - `/docs/performance/` - Performance optimization documentation
  - `/docs/archive/` - Historical documentation and deprecated guides

**Date-Based Organization Rules:**

- **ALWAYS use date prefixes** for new documentation: `YYYY-MM-DD_descriptive_name.md`
- Examples: `2026-02-03_database_optimization.md`, `2026-02-03_feature_implementation.md`
- Use ISO 8601 date format (YYYY-MM-DD) for consistent sorting
- Date represents when the work was completed or the document was finalized
- Helps track chronological evolution of the project
- Makes it easy to identify recent vs outdated documentation

**Critical Rules:**

- ❌ NEVER create .md files in project root (except README.md)
- ❌ NEVER create .md files in `/apps/*` directories or their subdirectories
- ❌ NEVER create .md files in package source directories (`/packages/*/src/`)
- ❌ NEVER create .md files in nested source directories
- ✅ ALWAYS use date prefixes for new docs: `YYYY-MM-DD_name.md`
- ✅ ALL documentation must go into appropriate `/docs` subfolder
- ✅ Choose the most specific subfolder for the content
- ✅ Keep the 3 core docs files (`ARCHITECTURE.md`, `EXECUTIVE_SUMMARY.md`, `ROADMAP.md`) updated with current project state

**Folder Selection Guidelines:**

When creating new documentation, select the folder based on content type:

- **Features** → New features, integrations, user-facing capabilities
- **Technical** → Architecture docs, API specs, deployment guides, infrastructure
- **Stability** → Bug fixes, debugging guides, stability improvements, security patches
- **Implementation** → Implementation summaries, refactoring guides, architecture changes
- **Backend-fixes** → Backend-specific bug fixes and patches
- **Performance** → Performance analysis, optimization guides, benchmarks
- **Archive** → Outdated docs, deprecated guides, historical reviews

## Security Considerations

### Authentication & Authorization

- **Never bypass authentication**: All user data access MUST use `protectedProcedure`
- **Automatic user scoping**: Use `getUserId(ctx)` helper to filter queries by authenticated user
- **Token validation**: Supabase JWT tokens validated on every request
- **User sync**: User data automatically synced from Supabase to local `users` table

### Data Protection

- **Financial precision**: ALWAYS use `Decimal.js` for monetary calculations (never floats)
- **Input validation**: All inputs validated with Zod schemas before processing
- **SQL injection prevention**: Use Drizzle ORM parameterized queries only
- **Sensitive data**: Never log or expose user credentials, API keys, or tokens

### Code Safety

- **Dependency scanning**: Check dependencies before adding new packages
- **Environment variables**: Use `.env` for secrets, never hardcode
- **Error handling**: Catch and sanitize errors before returning to client
- **Rate limiting**: External API calls (Finnhub, CoinGecko) are rate-limited

## Agent Workflow Patterns

### Before Making Changes

1. **Understand the codebase**: Explore relevant files and understand existing patterns
2. **Check current state**: Run `bun lint` to see baseline (use `bun lint:fix` to auto-fix before committing)
3. **Identify minimal changes**: Plan the smallest possible modifications
4. **Review architecture**: Check if changes align with clean architecture (use cases → services → repositories)

### During Development

1. **Make incremental changes**: One feature or fix at a time
2. **Follow existing patterns**: Match code style and structure of similar files
3. **Use proper layers**:
   - Business logic → Use Cases (`packages/core/src/use-cases/`)
   - External APIs → Services (`packages/core/src/services/`)
   - Database → Repositories (`packages/core/src/repositories/`)
   - HTTP/WebSocket → Routers (`apps/backend/src/presentation/routers/`)
4. **Test as you go**: Run relevant tests after each change

### Before Finalizing

1. **Auto-fix linter**: Run `bun lint:fix` — this applies all Biome formatting/style fixes automatically
2. **Verify clean**: Run `bun lint` to confirm no remaining errors after the fix
3. **Build check**: Verify TypeScript compilation succeeds with `bun type-check`
4. **Manual verification**: Test the actual functionality (run servers, test endpoints)
5. **Review changes**: Ensure only relevant files are modified
6. **Security check**: Verify no secrets committed, all auth checks in place

### Code Review Checklist

Before committing, verify:

- [ ] **`bun lint:fix` was run** (auto-fixes Biome formatting — required before every commit)
- [ ] Linter passes with no errors after fix (`bun lint`)
- [ ] TypeScript compiles without errors (`bun type-check`)
- [ ] No hardcoded secrets or sensitive data
- [ ] User data properly scoped with authentication
- [ ] Financial calculations use `Decimal.js`
- [ ] Database operations use Drizzle ORM
- [ ] Following clean architecture patterns
- [ ] Only minimal, necessary changes made
- [ ] Documentation updated if public APIs changed

## Troubleshooting & Debugging

### Common Issues

**Build Errors:**

```bash
# Clear build cache and reinstall
bun clean
rm -rf node_modules
bun install

# Check TypeScript compilation
cd apps/backend && bun run type-check
cd apps/frontendV2 && bun run type-check
```

**Database Issues:**

```bash
# Reset local database (CAUTION: destroys data)
bun run db:push

# View database schema
bun run db:studio

# Check migration status
cd apps/backend && bun run db:migrate
```

**Test Failures:**

```bash
# Run specific test file
bun test path/to/test.test.ts

# Run tests with verbose output
bun test --verbose

# Update test snapshots if needed
bun test --update-snapshots
```

**Authentication Errors:**

- Verify `.env` has correct Supabase keys
- Check token expiration (tokens expire after 1 hour)
- Ensure user exists in both Supabase and local `users` table
- Verify JWT signature validation is working

### Debugging Patterns

**Backend Debugging:**

```bash
# Enable verbose logging
cd apps/backend && bun dev:verbose

# Watch SQL queries
# Drizzle logs all queries when verbose mode enabled

# Test specific router
cd apps/backend && bun test src/presentation/routers/your-router.test.ts
```

**Frontend Debugging:**

- Check browser console for tRPC errors
- Verify API endpoint URLs in network tab
- Check React Query dev tools for cache state
- Enable React strict mode warnings

## CI/CD Integration

### GitHub Actions

**Automated Checks:**

- Linting with Biome
- TypeScript compilation
- Test suite execution
- Build verification

**When Changes Trigger CI:**

- All PRs must pass CI checks
- Push to main branch runs full test suite
- Failed CI requires fixes before merge

### Local Pre-commit Validation

```bash
# ALWAYS run before committing — in this order:
bun lint:fix        # Step 1: Auto-fix ALL Biome formatting and style issues (mandatory)
bun lint            # Step 2: Verify no remaining lint errors after auto-fix
bun run type-check  # Step 3: Check TypeScript types
bun run build       # Step 4: Verify build succeeds
```

## Tool Usage Patterns

### Preferred Tool Order

1. **Custom Agents**: Delegate to specialized agents when available
2. **Ecosystem Tools**: Use npm scripts, CLI tools (e.g., `bun`, `bunx`)
3. **Manual Edits**: Only when tools aren't available

### Example Workflows

**Adding New Feature:**

```bash
# 1. Create use case
# Edit: packages/core/src/use-cases/YourFeatureUseCase.ts

# 2. Add router endpoint
# Edit: apps/backend/src/presentation/routers/your-feature.ts

# 3. Add to main router
# Edit: apps/backend/src/presentation/router.ts

# 4. Frontend integration
# Edit: apps/frontendV2/src/components/YourFeature.tsx
```

**Database Schema Change:**

```bash
# 1. Edit schema
# Edit: packages/core/src/database/schema.ts

# 2. Generate migration
cd packages/core && bun run db:generate

# 3. User applies migration (not automated)
# User runs: bun run db:migrate

# 4. Update repositories if needed
# Edit: packages/core/src/repositories/
```

**Custom SQL Migration (dropping objects, raw SQL):**

```bash
# 1. Find next migration number
ls packages/core/src/database/migrations/*.sql | tail -1

# 2. Create migration file
# Create: packages/core/src/database/migrations/00XX_descriptive_name.sql

# 3. MUST register in journal (required for Drizzle to recognize it)
# Edit: packages/core/src/database/migrations/meta/_journal.json
# Add entry: { "idx": XX, "version": "7", "when": <timestamp>, "tag": "00XX_descriptive_name", "breakpoints": true }

# 4. User applies migration
# User runs: bun run db:migrate
```

**Bug Fix:**

```bash
# 1. Fix the bug
# Edit: packages/core/src/path/to/fix.ts

# 2. Auto-fix linting (REQUIRED before every commit)
bun lint:fix

# 3. Verify no remaining errors
bun lint

# 4. Type check
bun type-check
```
