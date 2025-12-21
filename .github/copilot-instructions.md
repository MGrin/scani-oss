# Copilot Instructions - Scani Finance SaaS

> **For GitHub Copilot Agents**: These instructions guide automated code changes. Always follow the workflow patterns and security considerations outlined below.

## Quick Reference for Agents

**Essential Commands:**
- `bun dev` - Start all development servers (backend + frontendV2 + landing)
- `bun dev:backend` - Start backend only
- `bun dev:frontend` - Start frontendV2 only
- `bun lint` - Run Biome linter across all packages
- `bun type-check` - Run TypeScript checks on all packages
- `cd packages/core && bun run db:generate` - Generate new migrations
- `bun run db:migrate` - Apply database migrations

**Critical Rules:**
- ✅ Always use `bun` and `bunx` (never npm/yarn/npx)
- ✅ Use Drizzle ORM for database operations (never raw SQL)
- ✅ Use `Decimal.js` for all financial calculations
- ✅ All user data must be scoped via `protectedProcedure`
- ✅ Use TypeDI Container for dependency injection
- ✅ **ALWAYS use proper ES6 imports at the top of files** (NEVER use `require()` or dynamic imports)
- ✅ Follow clean architecture - Use Cases → Services → Repositories
- ✅ Follow DRY, OOP, SOLID, and Onion Architecture principles
- ✅ Initialize container before importing routers (see `apps/backend/src/index.ts`)
- ❌ **NEVER use `require()` or `await import()` or any dynamic imports** - always use static ES6 imports
- ❌ Never auto-apply database migrations
- ❌ Never use TypeScript enums for dynamic data
- ❌ Never bypass authentication for user-scoped data
- ❌ Never commit secrets or sensitive data
- ❌ Never instantiate services directly - always use TypeDI Container

## Architecture Overview

**Scani** is a TypeScript monorepo personal finance SaaS built with tRPC, Drizzle ORM, Bun, and TypeDI. The architecture follows clean architecture principles with strict separation of concerns.

### Key Architecture Patterns

- **Monorepo Structure**: `apps/backend` (tRPC API), `apps/frontendV2` (React SPA), `apps/landing` (Marketing site), `apps/mobile` (React Native), `apps/telegram-bot` (Telegram integration), `packages/*` (shared code)
- **End-to-End Type Safety**: All API communication uses tRPC with shared TypeScript types
- **Database**: PostgreSQL with Drizzle ORM, dynamic enums stored in database tables (not TypeScript enums)
- **Authentication**: Supabase Auth with JWT tokens, user sync to local PostgreSQL via middleware
- **Dependency Injection**: TypeDI Container for service management and dependency injection
- **Clean Architecture**: Use Cases → Services → Repositories → Database
- **Real-time Updates**: WebSocket server for live portfolio updates
- **Error Tracking**: Sentry integration for both frontend and backend
- **AI Integration**: OpenAI integration for screenshot parsing and chat assistance

### Package Structure

**Packages:**
- `@scani/core` - Core business logic, database, services, use cases, repositories
- `@scani/integrations` - Integration framework (Plaid, Binance, Kraken, etc.)
- `@scani/rate-limiter` - Rate limiting utilities
- `@scani/shared` - Shared types and utilities (Zod schemas, Decimal.js helpers)

**Apps:**
- `@scani/backend` - tRPC API server with Elysia
- `@scani/frontend-v2` - React SPA with Vite
- `@scani/landing` - Marketing landing page
- `@scani/mobile` - React Native mobile app (Ignite template)
- `@scani/telegram-bot` - Telegram bot integration

### Import and Module Guidelines

**CRITICAL: Always use proper ES6 imports, NEVER use dynamic imports**

```typescript
// ✅ CORRECT - Proper ES6 imports at the top of the file
import { IntegrationManager } from '@scani/integrations';
import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { Container } from 'typedi';

// ✅ CORRECT - Using TypeDI Container
const service = Container.get(MyService);

// ❌ WRONG - Dynamic require statements
const { IntegrationManager } = require('@scani/integrations');

// ❌ WRONG - Async/dynamic imports
const { IntegrationManager } = await import('@scani/integrations');

// ❌ WRONG - Direct instantiation (bypass DI)
const service = new MyService();
```

### Dependency Injection with TypeDI

**All services must use TypeDI Container for dependency injection**

```typescript
// ✅ CORRECT - Service class with @Service decorator
import { Service } from 'typedi';

@Service()
export class MyService {
  constructor(
    private readonly repository: MyRepository,
    private readonly logger: Logger
  ) {}
}

// ✅ CORRECT - Getting service from container
import { Container } from 'typedi';
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
import { IntegrationManager } from '@scani/integrations';
import { Container } from 'typedi';

const manager = Container.get(IntegrationManager);
const integration = manager.getIntegration('binance');

// ✅ CORRECT - Use integration implementations through manager
await integration.validateCredentials({ apiKey, apiSecret });
```

## Development Workflows

### Essential Commands

```bash
# Development (from root)
bun dev                    # Start backend + frontendV2 + landing
bun dev:backend            # Start backend only
bun dev:frontend           # Start frontendV2 only
bun dev:landing            # Start landing page only
bun dev:mobile:ios         # Start mobile app (iOS)
bun dev:mobile:android     # Start mobile app (Android)

# Database (from packages/core)
cd packages/core
bun run db:generate        # Generate migrations after schema changes
bun run db:migrate         # Apply migrations
bun run db:studio          # Open Drizzle Studio (database GUI)

# Linting & Type Checking (from root)
bun lint                   # Run Biome linter
bun lint:fix              # Auto-fix linting issues
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

- Schema changes require `bun run db:generate`
- Always use Drizzle ORM syntax, never raw SQL for schema
- Database migrations will be applied by user only, never auto-apply them

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
  - `/docs/archive/` - Historical documentation and deprecated guides

**Rules:**

- Never create .md files in root (except README.md)
- Never create .md files in `/apps/backend` or `/apps/frontend`
- Never create .md files in nested source directories
- All AI-generated reports must go into appropriate `/docs` subfolder
- Keep the 3 core docs files updated with current project state

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
2. **Check current state**: Run `bun lint` to see baseline
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

1. **Run linter**: `bun lint` (fix all issues with `bun lint:fix`)
2. **Build check**: Verify TypeScript compilation succeeds with `bun type-check`
3. **Manual verification**: Test the actual functionality (run servers, test endpoints)
4. **Review changes**: Ensure only relevant files are modified
5. **Security check**: Verify no secrets committed, all auth checks in place

### Code Review Checklist

Before committing, verify:

- [ ] Linter passes (`bun lint`)
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
# Run before committing
bun run lint:fix        # Auto-fix linting issues
bun test                # Verify tests pass
bun run type-check      # Check TypeScript
bun run build           # Verify build succeeds
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

**Bug Fix:**
```bash
# 1. Fix the bug
# Edit: packages/core/src/path/to/fix.ts

# 2. Run linter
bun lint

# 3. Type check
bun type-check
```
