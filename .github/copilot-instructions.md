# Copilot Instructions - Scani Finance SaaS

> **For GitHub Copilot Agents**: These instructions guide automated code changes. Always follow the workflow patterns and security considerations outlined below.

## Quick Reference for Agents

**Essential Commands:**
- `bun dev` - Start development servers (frontend + backend)
- `bun lint` - Run Biome linter
- `bun type=check` - Run typecheck
- `bun run db:generate` - Generate new migrations

**Critical Rules:**
- ✅ Always use `bun` and `bunx` (never npm/yarn/npx)
- ✅ Use Drizzle ORM for database operations (never raw SQL)
- ✅ Use `Decimal.js` for all financial calculations
- ✅ All user data must be scoped via `protectedProcedure`
- ✅ Run linter, build, and tests before finalizing changes
- ✅ **ALWAYS use proper ES6 imports at the top of files** (NEVER use `require()` or `await import()` or dynamic imports)
- ✅ Follow clean architecture - use factory patterns from packages, never instantiate services directly
- ✅ Follow DRY, OOP, SOLID, and Onion Architecture principles
- ❌ **NEVER use `require()` or `await import()` or any dynamic imports** - always use static ES6 imports
- ❌ Never auto-apply database migrations
- ❌ Never use TypeScript enums for dynamic data
- ❌ Never bypass authentication for user-scoped data
- ❌ Never commit secrets or sensitive data
- ❌ Never instantiate integration services directly - always use factory functions from packages

## Architecture Overview

**Scani** is a TypeScript monorepo personal finance SaaS built with tRPC, Drizzle ORM, and Bun. The architecture follows a strict separation between frontend (React + Vite) and backend (Elysia + tRPC) with shared type definitions.

### Key Architecture Patterns

- **Monorepo Structure**: `apps/backend` (tRPC API), `apps/frontend` (React SPA), `packages/shared` (common types/utils)
- **End-to-End Type Safety**: All API communication uses tRPC with shared TypeScript types from `@scani/backend/router`
- **Database**: PostgreSQL with Drizzle ORM, dynamic enums stored in database tables (not TypeScript enums)
- **Authentication**: Supabase Auth with JWT tokens, user sync to local PostgreSQL via `middleware/auth.ts`
- **Clean Architecture**: Following DRY, OOP, SOLID, and Onion Architecture principles

### Import and Module Guidelines

**CRITICAL: Always use proper ES6 imports, NEVER use dynamic imports**

```typescript
// ✅ CORRECT - Proper ES6 imports at the top of the file
import { IntegrationManager } from '@scani/integrations';
import { IntegrationCredentialsService } from '@scani/core/services';
import { validateBinanceCredentials } from '@scani/integrations';

// ❌ WRONG - Dynamic require statements
const { IntegrationManager } = require('@scani/integrations');

// ❌ WRONG - Async/dynamic imports
const { IntegrationManager } = await import('@scani/integrations');

// ❌ WRONG - Lazy import functions
const getService = () => require('@scani/integrations/services/SomeService');
```

### Integration Architecture and Factory Pattern

**All integration implementations must be hidden behind factory functions**

The `@scani/integrations` package provides factory functions to create and configure integrations. **Never instantiate integration services directly in application code.**

```typescript
// ✅ CORRECT - Use factory functions from integrations package
import { validateBinanceCredentials } from '@scani/integrations';

const isValid = await validateBinanceCredentials(apiKey, apiSecret);

// ❌ WRONG - Direct instantiation of integration services
import { BinanceApiService } from '@scani/integrations/services/BinanceApiService';
const service = new BinanceApiService(baseUrl, rateLimiter);

// ❌ WRONG - Creating rate limiters in application code
const binanceRateLimiter = new RateLimiter(10, 1000);
```

**Factory Pattern Benefits:**
- Encapsulates implementation details (rate limiters, API URLs, configuration)
- Centralizes integration logic in the `@scani/integrations` package
- Makes code more maintainable and testable
- Prevents coupling between application code and integration implementations

**When adding new integrations:**
1. Create the integration implementation in `packages/integrations/src/implementations/`
2. Add factory functions in `packages/integrations/src/factories/`
3. Export factory functions from `packages/integrations/src/index.ts`
4. Use only the exported factory functions in application code

## Development Workflows

### Essential Commands

```bash
# Development (from root)
bun dev                    # Start both frontend + backend with hot reload
# from packages/core
bun run db:generate       # Generate migrations after schema changes
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

### Clean Architecture with Use Cases ✨ NEW

**The backend follows clean architecture principles with a dedicated use cases layer:**

- **Use Cases** (`apps/backend/src/application/use-cases/`) - Business logic encapsulation
  - 11 use cases created (transactions, tokens, holdings, wallets)
  - Each use case handles a single business operation
  - Reusable across routers, background jobs, and CLI tools
  - Examples: `CreateHoldingUseCase`, `ImportWalletAddressUseCase`
  
- **Services** (`apps/backend/src/application/services/`) - Infrastructure & external integrations
  - PricingService, PortfolioValuationService, UserContextService
  - Handle complex operations like price fetching (Finnhub, CoinGecko)
  - Rate limiting and external API management
  
- **Repositories** (`apps/backend/src/infrastructure/repositories/`) - Data access layer
  - Clean abstraction over database operations
  - Used by use cases for data persistence
  
- **Routers** (`apps/backend/src/presentation/routers/`) - Thin controllers
  - Delegate to use cases for business logic
  - Handle HTTP concerns (validation, response formatting)
  - Real-time updates via WebSocket

**Architecture Benefits:**
- ~1,178 lines removed from routers (51-91% reduction)
- Improved testability (use cases can be unit tested)
- Better separation of concerns
- Easier to maintain and scale

## Key Files to Understand

- `apps/backend/src/infrastructure/database/schema.ts` - Complete database schema with relationships
- `apps/backend/src/application/use-cases/` - Business logic layer (11 use cases)
- `apps/backend/src/application/use-cases/index.ts` - All use case exports
- `packages/shared/src/types/finance.ts` - All validation schemas using Zod
- `apps/backend/src/middleware/auth.ts` - Authentication and user sync logic
- `apps/backend/src/presentation/router.ts` - Main tRPC router assembly
- `apps/backend/src/presentation/routers/` - Individual route handlers (thin controllers)
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
2. **Check current state**: Run `bun test` and `bun run lint` to see baseline
3. **Identify minimal changes**: Plan the smallest possible modifications
4. **Review architecture**: Check if changes align with clean architecture (use cases → services → repositories)

### During Development

1. **Make incremental changes**: One feature or fix at a time
2. **Follow existing patterns**: Match code style and structure of similar files
3. **Use proper layers**:
   - Business logic → Use Cases (`apps/backend/src/application/use-cases/`)
   - External APIs → Services (`apps/backend/src/application/services/`)
   - Database → Repositories (`apps/backend/src/infrastructure/repositories/`)
   - HTTP/WebSocket → Routers (`apps/backend/src/presentation/routers/`)
4. **Test as you go**: Run relevant tests after each change

### Before Finalizing

1. **Run full test suite**: `bun test` (maintain 93%+ coverage)
2. **Run linter**: `bun run lint` (fix all issues with `bun run lint:fix`)
3. **Build check**: Verify TypeScript compilation succeeds
4. **Manual verification**: Test the actual functionality (run servers, test endpoints)
5. **Review changes**: Ensure only relevant files are modified
6. **Security check**: Verify no secrets committed, all auth checks in place

### Code Review Checklist

Before committing, verify:

- [ ] All tests pass (`bun test`)
- [ ] Linter passes (`bun run lint`)
- [ ] TypeScript compiles without errors
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
# Edit: apps/backend/src/application/use-cases/your-feature.use-case.ts

# 2. Add router endpoint
# Edit: apps/backend/src/presentation/routers/your-feature.router.ts

# 3. Add to main router
# Edit: apps/backend/src/presentation/router.ts

# 4. Test
bun test apps/backend/src/presentation/routers/your-feature.test.ts

# 5. Frontend integration
# Edit: apps/frontendV2/src/components/YourFeature.tsx
```

**Database Schema Change:**
```bash
# 1. Edit schema
# Edit: apps/backend/src/infrastructure/database/schema.ts

# 2. Generate migration
cd apps/backend && bun run db:generate

# 3. User applies migration (not automated)
# User runs: bun run db:migrate

# 4. Update repositories if needed
# Edit: apps/backend/src/infrastructure/repositories/
```

**Bug Fix:**
```bash
# 1. Write failing test first
# Create: apps/backend/src/path/to/bug.test.ts

# 2. Fix the bug
# Edit: apps/backend/src/path/to/fix.ts

# 3. Verify test passes
bun test apps/backend/src/path/to/bug.test.ts

# 4. Run full suite
bun test
```
