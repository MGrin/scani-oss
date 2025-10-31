<!--
SYNC IMPACT REPORT
==================
Version Change: 1.0.0 → 1.1.0
Rationale: MINOR version bump - Added new principles and expanded technology standards based on codebase exploration

Principles Modified:
- I. End-to-End Type Safety (EXPANDED - added React Hook Form, Sentry context)
- IV. Clean Architecture (EXPANDED - added DI, Repository, Use Case patterns, layered architecture details)
- VI. Code Quality Standards (EXPANDED - added structured logging requirements)

New Principles Added:
- VII. Observability & Error Tracking (NEW - Sentry, Pino logging)
- VIII. Performance & Scalability (NEW - rate limiting, PWA, caching)

Technology Standards Expanded:
- Added Elysia framework (backend server)
- Added Pino (structured logging)
- Added TypeDI (dependency injection)
- Added Sentry (error monitoring)
- Added React Hook Form (form handling)
- Added Radix UI (component primitives)
- Added ethers.js (blockchain integration)
- Added Decimal.js (financial precision)

Templates Status:
✅ plan-template.md - constitution check already flexible for new principles
✅ spec-template.md - no changes needed, functional requirements approach still valid
✅ tasks-template.md - observability tasks can be added as needed
✅ checklist-template.md - compatible with new quality gates
✅ agent-file-template.md - will track new technologies automatically

Follow-up Items:
- None (all patterns documented, no breaking changes)

Files Modified:
- .specify/memory/constitution.md (updated from 1.0.0 to 1.1.0)
-->

# Scani Constitution

## Core Principles

### I. End-to-End Type Safety (NON-NEGOTIABLE)

**Type safety MUST be enforced across the entire application stack without exceptions.**

- All TypeScript code MUST have strict mode enabled with no `any` types except where explicitly justified
- API contracts MUST be type-safe using tRPC with shared type definitions
- Database schema MUST be type-safe using Drizzle ORM with TypeScript inference
- Data validation MUST use Zod schemas that align with TypeScript types
- Frontend-backend communication MUST share type definitions via workspace packages
- Form validation MUST use React Hook Form with Zod resolvers for type-safe forms
- No runtime type coercion without explicit validation
- Error tracking contexts (Sentry) MUST use typed user/context objects

**Rationale**: Type safety eliminates an entire class of bugs at compile time, enables confident refactoring, and provides superior IDE support. For a financial application handling sensitive monetary data, type errors can lead to calculation mistakes and data corruption.

### II. Testing Excellence (NON-NEGOTIABLE)

**All features MUST maintain 93%+ test coverage with comprehensive test strategies.**

- Unit tests MUST be written for all business logic and utility functions
- Integration tests MUST cover all database operations and API endpoints
- Type tests MUST validate Zod schemas and type definitions
- Financial calculations MUST have edge case tests (negative balances, precision, large numbers)
- Database isolation MUST be enforced (each test uses fresh state)
- Real database testing MUST be used (no mocks for ORM operations)
- Repository methods MUST be tested with transaction support
- Use cases MUST have integration tests covering happy path and error scenarios
- Tests MUST fail before implementation (TDD encouraged)
- Frontend testing is currently deferred but MUST be implemented before production

**Rationale**: Financial applications require absolute reliability. Test coverage ensures correctness of monetary calculations, prevents data loss, and enables safe refactoring. The 93%+ threshold is a proven baseline for production-grade financial software.

### III. Security & Data Isolation (NON-NEGOTIABLE)

**User data MUST be completely isolated with JWT-based authentication protecting all endpoints.**

- ALL tRPC procedures MUST use `protectedProcedure` requiring valid JWT tokens
- Database queries MUST automatically filter by authenticated user ID
- JWT tokens MUST be validated on every API request (local verification + Supabase fallback)
- Authorization tokens MUST be sent via secure HTTP headers only
- Secrets MUST be managed via environment variables (never hardcoded)
- Password reset MUST use email-based Supabase Auth flows
- Session management MUST support automatic token refresh
- Route protection MUST be enforced on frontend via `ProtectedRoute` component
- Rate limiting MUST be applied to all API endpoints to prevent abuse
- User context MUST be synced to database on authentication for data isolation

**Rationale**: Personal finance data is highly sensitive. A single data leak or cross-user data exposure would destroy user trust and violate privacy regulations. Defense-in-depth ensures security at every layer.

### IV. Clean Architecture (MANDATORY)

**Code MUST follow clean architecture principles with dependency injection, repository pattern, and clear layered separation.**

**Backend Architecture Layers:**

- **Domain Layer** (`domain/entities/`): Core business entities and domain logic
- **Application Layer** (`application/`):
  - `services/`: Business logic and orchestration (e.g., `AccountService`, `PricingService`)
  - `use-cases/`: Complex operations as explicit use case objects (e.g., `CreateHoldingsWithDependenciesUseCase`)
- **Infrastructure Layer** (`infrastructure/`):
  - `database/`: Schema, migrations, connection
  - `repositories/`: Data access using Repository pattern extending `BaseRepository`
  - `external-services/`: Third-party integrations (AI, blockchain, pricing)
  - `websocket/`: Real-time communication services
- **Presentation Layer** (`presentation/`):
  - `routers/`: tRPC routers for API endpoints
  - `middleware/`: Auth, rate limiting, CORS
  - `trpc.ts`: tRPC initialization with context and procedures

**Dependency Injection:**

- ALL services and repositories MUST use TypeDI with `@Service()` decorator
- Dependencies MUST be injected via constructor (no manual instantiation)
- Container MUST be initialized before service usage
- Transaction support MUST be propagated through repository methods

**Repository Pattern:**

- ALL data access MUST go through repositories extending `BaseRepository`
- Repositories MUST support optional transaction parameter for atomic operations
- CRUD operations MUST use Drizzle ORM with type-safe queries
- Complex queries MAY be added as custom repository methods

**General Principles:**

- Prefer functional programming patterns over imperative code
- Components/functions MUST have single, clear responsibilities
- Dependencies MUST flow inward (domain ← application ← infrastructure ← presentation)
- Shared utilities MUST be extracted to workspace packages
- Solutions MUST be concise, smart, and prioritize readability
- No premature abstraction - simplicity first, refactor when patterns emerge

**Frontend Architecture:**

- **Components**: Organized by purpose (features/, layout/, selectors/, ui/)
- **Contexts**: State management via React Context (Auth, Realtime, Theme)
- **Hooks**: Custom hooks for logic reuse and separation of concerns
- **Pages**: Route-level components with composition of smaller components
- Component logic MUST be extracted to custom hooks when reusable

**Rationale**: Clean architecture with explicit patterns (DI, Repository, Use Cases) enables long-term maintainability, testing, and team collaboration. Layered architecture prevents coupling and makes dependencies explicit. For a SaaS platform, architectural discipline prevents technical debt accumulation.

### V. Monorepo Discipline (MANDATORY)

**Workspace organization MUST maintain clear boundaries between apps and shared packages.**

- Apps MUST NOT directly import from other apps (use shared packages)
- Shared packages MUST contain only reusable types, utilities, and schemas
- Each app MUST have its own package.json and dependencies
- Breaking changes in shared packages MUST be coordinated across all consumers
- Bun workspaces MUST be the single source of dependency management
- Migration scripts MUST update all affected packages atomically
- New apps MUST follow the established structure (backend/, frontendV2/, landing/, mobile/)
- Workspace references MUST use `workspace:*` protocol for internal packages

**Rationale**: Monorepo structure enables code sharing while maintaining modularity. Clear boundaries prevent circular dependencies and enable independent deployment. For a multi-platform SaaS (web + mobile + landing), this prevents the big ball of mud anti-pattern.

### VI. Code Quality Standards (MANDATORY)

**Code MUST adhere to project naming conventions, pass Biome.js linting, and use structured logging.**

**Naming Conventions:**

- Component filenames: PascalCase (e.g., `AccountCard.tsx`)
- Other files: camelCase (e.g., `authUtils.ts`, `tokenService.ts`)
- Variables/functions: camelCase (e.g., `getUserAccounts`, `totalBalance`)
- Constants/map keys: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_COUNT`, `API_TIMEOUT`)
- React components: PascalCase (e.g., `function AccountList()`)
- Services/Repositories: PascalCase with suffix (e.g., `AccountService`, `UserRepository`)
- Use cases: PascalCase with `UseCase` suffix (e.g., `CreateHoldingUseCase`)

**Structured Logging:**

- ALL components MUST use component-specific child loggers via `createComponentLogger()`
- Log levels MUST be appropriate: trace/debug (development), info (normal), warn (issues), error (failures)
- Request tracking MUST include `requestId` for correlation
- Performance-critical operations MUST log duration using `createTimer()`
- Sensitive data (passwords, tokens) MUST NEVER be logged
- Database operations MAY log queries in debug mode (configurable via `LOG_SQL_QUERIES`)
- Frontend MUST use console methods appropriately (not for sensitive data)

**Quality Gates:**

- Biome.js linting MUST pass with zero warnings before commit
- TypeScript compilation MUST succeed with strict mode enabled
- Format checks MUST pass (`bun format`)
- Database migrations MUST be generated before schema changes
- Environment variables MUST be documented in `.env.example` files
- All biome-ignore comments MUST include justification

**Rationale**: Consistent naming and quality standards reduce cognitive load, enable better code search, and prevent style debates. Structured logging enables production debugging and performance analysis. Automated linting catches common errors and enforces team agreements.

### VII. Observability & Error Tracking (MANDATORY)

**Production systems MUST have comprehensive logging, error tracking, and monitoring.**

**Error Tracking (Sentry):**

- Sentry MUST be initialized in both frontend and backend
- User context MUST be set on authentication for error correlation
- Errors MUST be captured with appropriate context (request ID, user ID, operation)
- Performance tracing MUST be enabled (10% sample rate in production)
- Sensitive data MUST be scrubbed before sending to Sentry
- Development environments MAY disable Sentry unless explicitly enabled
- Database queries and tRPC operations SHOULD use Sentry spans for tracing

**Structured Logging (Pino):**

- Production logs MUST use JSON format for machine parsing
- Development logs SHOULD use human-readable format with colors and emojis
- Component-based loggers MUST be used for context isolation
- Request/response cycles MUST be logged with timing information
- Critical operations (auth, payments, data mutations) MUST have audit logs
- Log levels MUST be configurable via environment variables
- WebSocket messages MAY be logged in development for debugging

**Configuration Requirements:**

- `SENTRY_DSN` MUST be set in production environments
- `LOG_LEVEL` SHOULD be `info` in production, `debug` in development
- `LOG_PRETTY` SHOULD be `false` in production for JSON logging
- Logging middleware MUST track request IDs for distributed tracing

**Rationale**: Financial applications require detailed audit trails and error tracking for compliance, debugging, and user support. Structured logging enables automated alerting and analysis. Sentry integration provides real-time error notifications and performance insights.

### VIII. Performance & Scalability (MANDATORY)

**Applications MUST be designed for performance, caching, and offline capability.**

**Rate Limiting:**

- API endpoints MUST have rate limiting middleware to prevent abuse
- Rate limits SHOULD be configurable via environment variables
- Rate limit violations MUST return appropriate HTTP status codes
- Different endpoints MAY have different rate limit thresholds

**Caching & Data Fetching:**

- Frontend MUST use React Query (via tRPC) for automatic caching and revalidation
- Expensive calculations MUST be memoized using `useMemo` or backend caching
- Real-time updates SHOULD use WebSocket for efficiency (not polling)
- Token prices SHOULD be cached with appropriate TTL

**Progressive Web App (PWA):**

- Frontend MUST support PWA installation
- Service workers SHOULD enable offline functionality for cached data
- PWA MUST handle online/offline transitions gracefully
- Authentication flow MUST adapt for PWA (OTP codes instead of magic links)

**Financial Precision:**

- Monetary calculations MUST use `Decimal.js` (never native `number` for money)
- Token amounts MUST respect decimal precision from token metadata
- Price calculations MUST avoid floating-point arithmetic errors
- Database MUST store financial values with appropriate precision

**Blockchain Integration:**

- Blockchain operations MUST be optimized (batch RPC calls when possible)
- Multiple chain support MUST use strategy pattern (`BlockchainServiceManager`)
- Wallet imports SHOULD be asynchronous with progress indicators
- External API calls (pricing, blockchain) MUST have timeout and retry logic

**Rationale**: Performance directly impacts user experience and operational costs. Rate limiting prevents abuse and ensures fair resource allocation. Caching reduces database load and API costs. PWA support enables mobile-like experience and offline access. Financial precision is non-negotiable for a finance app.

## Technology Standards

### Required Stack Components

**All features MUST use the established technology stack unless explicitly justified:**

**Runtime & Language:**

- **Runtime**: Bun (latest version) - for backend and package management
- **Language**: TypeScript (strict mode) - for all code

**Backend Framework & API:**

- **Server Framework**: Elysia (https://elysiajs.com/introduction.html) - for HTTP server
- **API Layer**: tRPC (https://trpc.io/docs) - for type-safe API endpoints
- **Validation**: Zod (https://zod.dev/) - for schema validation
- **Dependency Injection**: TypeDI (https://github.com/typestack/typedi) - for service container

**Database & ORM:**

- **Database**: PostgreSQL (https://www.postgresql.org/docs/)
- **ORM**: Drizzle ORM (https://orm.drizzle.team/docs/overview)
- **Migrations**: DrizzleKit (https://orm.drizzle.team/docs/kit-overview)
- **Financial Math**: Decimal.js (https://mikemcl.github.io/decimal.js/) - for precise calculations

**Authentication & Security:**

- **Auth Provider**: Supabase Auth (https://supabase.com/docs/guides/auth)
- **JWT Handling**: jsonwebtoken library for local verification
- **Rate Limiting**: Custom Elysia middleware

**Frontend Framework:**

- **UI Framework**: React 18 (https://react.dev/)
- **Build Tool**: Vite v5 (https://v5.vite.dev/)
- **Routing**: React Router v6 (https://reactrouter.com/home)
- **Data Fetching**: tRPC React Query (https://trpc.io/docs/client/react)
- **State Management**: React Context + React Query cache

**Styling & UI Components:**

- **Styling**: Tailwind CSS v3 (https://v3.tailwindcss.com/docs)
- **Component Library**: Shadcn UI (https://ui.shadcn.com/docs)
- **Primitives**: Radix UI (https://www.radix-ui.com/)
- **Icons**: Lucide React (https://lucide.dev/)
- **Utilities**: clsx, tailwind-merge, class-variance-authority

**Forms & Validation:**

- **Form Handling**: React Hook Form (https://react-hook-form.com/)
- **Form Validation**: Zod with @hookform/resolvers
- **Input Components**: Custom components built on Radix UI primitives

**Real-time & External Services:**

- **WebSocket**: Native WebSocket API (https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- **Blockchain**: ethers.js v6 (https://docs.ethers.org/v6/) - for EVM chains
- **AI Services**: Multiple providers (OpenAI, Perplexity, DeepSeek) via strategy pattern

**Observability & Monitoring:**

- **Logging**: Pino (https://getpino.io/) - structured logging
- **Error Tracking**: Sentry (https://docs.sentry.io/) - for frontend and backend
- **Tracing**: Sentry performance monitoring

**Mobile (React Native):**

- **Framework**: React Native + Expo
- **Template**: Ignite (https://github.com/infinitered/ignite) - for theming and i18n
- **API Client**: tRPC React Native

**Development Tools:**

- **Package Manager**: Bun workspaces
- **Linter**: Biome.js (https://biomejs.dev/)
- **Type Checking**: TypeScript compiler
- **Testing**: Bun Test (https://bun.sh/docs/cli/test)

### Documentation Reference Requirement (NON-NEGOTIABLE)

**Before planning ANY solution, AI agents MUST consult official documentation:**

- Check technology version compatibility with existing `package.json` files
- Verify API patterns match current framework versions
- Reference official docs for proprietary patterns (tRPC procedures, Drizzle queries, Supabase auth flows, TypeDI decorators)
- Confirm migration paths for version upgrades
- Validate against official examples, not blog posts or outdated Stack Overflow answers
- For financial calculations, always verify Decimal.js API usage

**Required Documentation Links:**

**Core Technologies:**

- React: https://react.dev/
- TypeScript: https://www.typescriptlang.org/docs/
- Bun: https://bun.sh/docs

**Backend:**

- Elysia: https://elysiajs.com/
- tRPC: https://trpc.io/docs
- Zod: https://zod.dev/
- Drizzle ORM: https://orm.drizzle.team/docs/overview
- DrizzleKit: https://orm.drizzle.team/docs/kit-overview
- PostgreSQL: https://www.postgresql.org/docs/
- TypeDI: https://github.com/typestack/typedi
- Pino: https://getpino.io/
- Decimal.js: https://mikemcl.github.io/decimal.js/

**Frontend:**

- Vite v5: https://v5.vite.dev/
- Vite v6: https://v6.vite.dev/ (for future upgrades)
- Tailwind v3: https://v3.tailwindcss.com/docs
- Tailwind v4: https://tailwindcss.com/docs (for future upgrades)
- Shadcn UI: https://ui.shadcn.com/docs
- Radix UI: https://www.radix-ui.com/
- React Router: https://reactrouter.com/home
- React Hook Form: https://react-hook-form.com/
- React Query: https://tanstack.com/query/latest

**Authentication & Security:**

- Supabase: https://supabase.com/docs
- Supabase Auth: https://supabase.com/docs/guides/auth

**Blockchain & Web3:**

- ethers.js v6: https://docs.ethers.org/v6/

**Monitoring:**

- Sentry (Bun): https://docs.sentry.io/platforms/javascript/guides/bun/
- Sentry (React): https://docs.sentry.io/platforms/javascript/guides/react/

**Standards:**

- WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- PWA: https://web.dev/progressive-web-apps/

**Rationale**: Technology ecosystems evolve rapidly. Consulting official docs prevents using deprecated patterns, ensures compatibility, and reduces debugging time. Financial applications cannot afford framework misuse or outdated patterns.

## Development Workflow

### Pre-Implementation Requirements

**Before writing code, developers MUST:**

1. **Verify specification completeness** - All user stories, functional requirements, and acceptance criteria documented in spec.md
2. **Review constitution compliance** - Check that planned approach aligns with all non-negotiable principles
3. **Consult documentation** - Reference official docs for all technologies being used
4. **Design data model** - Define entities, relationships, and validation rules in data-model.md
5. **Define API contracts** - Document tRPC endpoints with input/output schemas in contracts/
6. **Plan dependency injection** - Identify services, repositories, and their dependencies
7. **Plan migration strategy** - If touching database schema, prepare Drizzle migration
8. **Design logging strategy** - Identify what needs logging, at what levels, with what context
9. **Write tests first** - For TDD features, write failing tests before implementation

### Code Review Requirements

**All pull requests MUST:**

- Pass all automated tests with 93%+ coverage maintained
- Pass Biome.js linting with zero warnings
- Pass TypeScript compilation with strict mode
- Include database migrations if schema changed
- Document any new environment variables in `.env.example`
- Have meaningful commit messages describing intent
- Reference related spec/task IDs for traceability
- Include appropriate logging for new operations
- Add Sentry context for error-prone operations
- Update JSDoc comments for public APIs

### Quality Gates

**The following MUST be verified before merging:**

- ✅ All unit tests pass
- ✅ All integration tests pass (including repository and use case tests)
- ✅ No TypeScript errors with strict mode
- ✅ Biome.js linting passes
- ✅ Database migrations run successfully
- ✅ Manual testing of user-facing features completed
- ✅ No console errors in browser/terminal
- ✅ Authentication/authorization verified for protected features
- ✅ Rate limiting tested (if applicable)
- ✅ Logging output reviewed (correct levels, no sensitive data)
- ✅ Sentry integration tested (errors reported correctly)
- ✅ Performance profiled (no obvious bottlenecks)

## Governance

### Amendment Process

**This constitution can ONLY be amended through:**

1. Documented proposal with rationale in `.specify/memory/` directory
2. Impact analysis on existing features and templates
3. Version bump following semantic versioning rules:
   - **MAJOR**: Backward incompatible principle removals or redefinitions
   - **MINOR**: New principles added or materially expanded guidance
   - **PATCH**: Clarifications, wording fixes, non-semantic refinements
4. Update of all dependent templates in `.specify/templates/`
5. Synchronization with project README.md if tech stack changes
6. Approval by project lead or unanimous team consensus

### Compliance & Enforcement

**Constitution compliance is NON-NEGOTIABLE:**

- All `/speckit.*` commands MUST verify constitution alignment before proceeding
- Plan templates MUST include "Constitution Check" section validating compliance
- Violations MUST be justified in "Complexity Tracking" table with simpler alternatives documented
- Team members MUST challenge unjustified violations in code review
- Automated tooling (Biome.js, TypeScript strict mode) enforces programmatic rules
- Financial correctness and security principles take precedence over convenience
- Logging and monitoring requirements are mandatory for production deployments

### Living Document Philosophy

**This constitution serves as:**

- The single source of truth for non-negotiable architectural decisions
- A contract between team members about shared standards
- A reference for AI agents and automation to verify compliance
- A teaching tool for onboarding new contributors
- An evolving document that adapts to proven lessons learned
- A guide for technology selection and architectural patterns

**This constitution does NOT:**

- Prescribe implementation details (those belong in specs/plans)
- Replace official technology documentation
- Prevent experimentation in non-production branches
- Override security or legal requirements
- Dictate specific business logic or domain rules

**Version**: 1.1.0 | **Ratified**: 2025-10-31 | **Last Amended**: 2025-10-31
