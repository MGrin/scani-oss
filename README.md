# Scani - Personal Finance Management SaaS

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/MGrin/REPLACE_WITH_GIST_ID/raw/scani-coverage.json)](#-testing--coverage)

A comprehensive personal finance management platform built with a modern TypeScript stack and extensive integrations with banks, brokerages, and cryptocurrency exchanges.

## 🌟 Features

### Core Capabilities
- **Real-time Portfolio Tracking** - WebSocket-powered live updates
- **Bank & Brokerage Integration** - Plaid integration for automatic bank account sync
- **Cryptocurrency Support** - Track holdings across multiple blockchains and exchanges
- **Exchange Integrations** - Binance, Kraken, and more
- **AI-Powered Features** - Screenshot parsing for quick data entry, AI chat assistant
- **Scheduled Transactions** - Automated recurring income allocations and payments
- **Asset Allocation Analysis** - Visual breakdown of portfolio composition
- **Multi-Currency Support** - Track assets in multiple currencies with automatic conversion

### Technical Highlights
- **End-to-End Type Safety** - Full TypeScript with tRPC for type-safe API calls
- **Clean Architecture** - Use Cases → Services → Repositories pattern
- **Dependency Injection** - TypeDI for service management
- **Real-time Updates** - WebSocket server for instant portfolio changes
- **Async Jobs** - BullMQ on Redis for screenshot parsing, imports, pricing, and user data deletion
- **Rate Limiting** - Smart rate limiting for external API calls
- **Database Migrations** - Drizzle ORM with automatic migration generation

## 🏗️ Tech Stack

### Frontend

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Shadcn UI** - UI components
- **React Router** - Routing
- **tRPC Client** - Type-safe API communication
- **React Query** - Data fetching and caching

### Backend

- **Bun** - Runtime and package manager
- **TypeScript** - Type safety
- **Elysia** - Fast HTTP server framework
- **tRPC** - End-to-end type safety
- **TypeDI** - Dependency injection container
- **Zod** - Schema validation
- **Drizzle ORM** - Type-safe database queries
- **PostgreSQL (Neon)** - Primary database
- **Better-Auth** - Authentication (sessions in Postgres)
- **BullMQ + Redis (Upstash)** - Async job queue
- **WebSocket** - Real-time updates via custom WebSocket server
- **Pino** - Structured logging
- **OpenAI** - AI integration for screenshot parsing and chat

### Integrations

- **Plaid** - Bank and brokerage account integration
- **Binance** - Cryptocurrency exchange integration
- **Kraken** - Cryptocurrency exchange integration
- **DefiLlama** - DeFi protocol data
- **Blockchain Explorers** - Ethereum, Bitcoin, and other blockchain data
- **CoinGecko** - Cryptocurrency price data

### Landing

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Shadcn UI** - UI components
- **React Router** - Routing

### Development

- **Bun Workspaces** - Monorepo management
- **Biome** - Fast linter and formatter
- **Drizzle Kit** - Database migrations and schema management
- **TypeDI** - Dependency injection
- **Decimal.js** - Precise financial calculations

## 📁 Project Structure

```
scani/
├── apps/
│   ├── backend/
│   │   ├── api/              # tRPC API server with Elysia (BullMQ producer)
│   │   ├── worker/           # BullMQ consumer; runs scheduled + user-initiated jobs
│   │   └── data-provider/    # tRPC service that owns Scani-managed third-party calls
│   └── frontend/
│       ├── app/              # React + Vite SPA, main frontend (code under src/v2/)
│       ├── cloud/            # cloud.scani.xyz Tier 2 console
│       ├── admin/            # Passkey-gated infra dashboard (Next.js, Cloudflare Pages)
│       └── landing/          # Marketing site at scani.xyz (Vite + React, Cloudflare Pages)
│
├── packages/
│   ├── business/             # Domain logic + the wire contract
│   │   ├── domain/           # Services, repositories, use cases (most business logic)
│   │   └── shared/           # Zod schemas, Decimal helpers, cross-cutting types
│   ├── infra/                # Pure system concerns (no business knowledge)
│   │   ├── db/               # Drizzle schema, migrations, postgres.js connection
│   │   ├── queue/            # BullMQ job names, repeatable schedules, enqueue helpers
│   │   ├── email/            # Email sending (Fastmail JMAP / SMTP)
│   │   ├── logging/          # Structured logging (pino)
│   │   ├── storage/          # Object storage abstraction (Cloudflare R2)
│   │   ├── realtime/         # Realtime / SSE updates
│   │   ├── rate-limiter/     # Token-bucket rate limiter (Redis-backed)
│   │   └── config/           # Shared env-validation primitives
│   ├── clients/              # Outbound network adapters
│   │   ├── providers/        # Unified 3rd-party integrations (pricing, balances, AI, …)
│   │   └── cloud-client/     # tRPC client for backend/data-provider
│   └── frontend/             # Browser-only
│       └── ui/               # @scani/ui — design system + shared client plumbing
│
├── infra/
│   └── terraform/            # Source of truth for Cloudflare/Fly/Neon/Upstash/GitHub
│
├── docs/                     # See "Documentation" section below
├── .github/workflows/        # CI + deploy + terraform + backup workflows
├── docker-compose.yml        # Local Postgres + Redis + Mailpit + MinIO
└── package.json              # Bun workspace root
```

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest version recommended)
- PostgreSQL database (Neon, or local — see `docker-compose.yml`)
- Redis (Upstash, or local — see `docker-compose.yml`)
- Node.js 18+ (for compatibility with some tools)

### Installation

1. **Clone the repository and install dependencies**

   ```bash
   git clone <repository-url>
   cd scani
   bun install
   ```

2. **Set up environment variables**

   **Backend Environment Variables:**

   ```bash
   # Copy the example file and customize
   cp apps/backend/api/.env.example apps/backend/api/.env.local
   ```

   The root `.env.example` documents every variable for all three deployment tiers (OSS self-hosted with a local data-provider, semi-managed with Scani's hosted data-provider, and fully-managed SaaS on Fly+Neon+Upstash). Copy and fill in the values you need:

   ```bash
   # At the repo root
   cp .env.example .env.local
   ```

   Minimum for local dev:

   ```bash
   DATABASE_URL=postgres://scani:scani@localhost:5433/scani?sslmode=disable
   REDIS_URL=redis://localhost:6380
   SMTP_URL=smtp://localhost:1026
   BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
   OPENAI_API_KEY=<optional, for AI features>
   PLAID_CLIENT_ID=<optional, for Plaid>
   PLAID_SECRET=<optional, for Plaid>
   ```

3. **Start local infrastructure**

   The easiest path is docker-compose — it brings up Postgres (`localhost:5433`), Redis (`localhost:6380`), Mailpit (SMTP `localhost:1026`, UI `http://localhost:8026`), and MinIO (`localhost:9000`, console `http://localhost:9001`):

   ```bash
   docker compose up -d postgres redis mailpit minio
   ```

   For full-stack containerized testing (backend + worker + frontends + data-provider inside Docker):

   ```bash
   bun dev:stack          # syncs per-app .env, then `docker compose --profile full up -d --build`
   bun dev:stack:down     # stops + removes containers (volumes preserved)
   ```

   Auth emails (magic-link, OTP, verification) land in Mailpit at `http://localhost:8026`.

4. **Apply database migrations**

   ```bash
   # Generate migrations (only needed if schema changed)
   cd packages/core
   bun run db:generate

   # Apply migrations to database
   bun run db:migrate
   ```

5. **Start the development servers**

   **Option 1: Start all servers at once (recommended)**
   ```bash
   bun dev
   ```
   This starts:
   - API on `http://localhost:3001` (HTTP + WebSocket on the same port)
   - Frontend SPA on `http://localhost:5173`

   **Option 2: Start servers individually**
   ```bash
   # Terminal 1 — API
   bun dev:api

   # Terminal 2 — Frontend SPA
   bun dev:app

   # Terminal 3 — Worker (needed for any async jobs)
   bun dev:worker

   # Terminal 4 — Data-provider (needed if SCANI_CLOUD_URL is set)
   bun dev:data-provider

   # Other apps
   bun dev:landing       # Marketing site
   bun dev:cloud         # Tier 2 console
   bun dev:admin         # Admin dashboard
   ```

6. **Access the application**

   - Web App: `http://localhost:5173`
   - API Server: `http://localhost:3001`
   - Landing Page: `http://localhost:5174`

## 🛠️ Development Commands

### General Commands (from root):
- `bun dev` - Start API + frontend SPA concurrently
- `bun dev:api` - Start tRPC API server only
- `bun dev:app` - Start main frontend SPA only
- `bun dev:worker` - Start BullMQ worker only
- `bun dev:data-provider` - Start data-provider sidecar only
- `bun dev:landing` / `bun dev:cloud` / `bun dev:admin` - Other frontends
- `bun build` - Build api + main frontend for production
- `bun clean` - Clean build artifacts

### Code Quality Commands:
- `bun lint` - Run Biome linter across all packages
- `bun lint:fix` - Auto-fix linting issues
- `bun type-check` - Run TypeScript type checking on all packages
- `bun format` - Format code with Biome

### Database Commands (from packages/core):
- `cd packages/core && bun run db:generate` - Generate migrations from schema changes
- `bun run db:migrate` - Apply pending migrations to database
- `bun run db:studio` - Open Drizzle Studio for database management

### Package-Specific Commands:
```bash
# API
cd apps/backend/api
bun dev              # Start with debug logging

# Frontend SPA
cd apps/frontend/app
bun dev              # Start development server
bun build            # Build for production
```

## 🏛️ Architecture Overview

### Clean Architecture Principles

Scani follows clean architecture with clear separation of concerns:

1. **Presentation Layer** (`apps/backend/api/src/presentation/`)
   - tRPC routers - Thin controllers that handle HTTP/WebSocket
   - Middleware - Authentication, rate limiting, logging
   - Type definitions and validation

2. **Use Case Layer** (`packages/business/domain/src/use-cases/`)
   - Business logic encapsulation
   - Single responsibility per use case
   - Reusable across different entry points

3. **Service Layer** (`packages/business/domain/src/services/`)
   - Infrastructure services (Pricing, Portfolio Valuation, AI)
   - External API integrations
   - Complex calculations and aggregations

4. **Repository Layer** (`packages/business/domain/src/repositories/`)
   - Data access abstraction
   - Database operations via Drizzle ORM
   - Query optimization

5. **Schema** (`packages/infra/db/src/schema.ts`)
   - Drizzle schema, migrations, and the postgres.js connection

### Dependency Injection

All services use **TypeDI** for dependency injection:
- Services are registered with `@Service()` decorator
- Retrieved from container using `Container.get(ServiceName)`
- Container initialized before application startup
- Promotes testability and loose coupling

## 📊 Database Architecture

Scani uses **Drizzle ORM** for type-safe database operations with PostgreSQL.

### Database Schema Design

The application uses **dynamic enums** stored in database tables instead of TypeScript enums:

**Enum Tables:**
- `institutionTypes` - Bank, broker, exchange, wallet types
- `accountTypes` - Checking, savings, investment, crypto wallet
- `tokenTypes` - Fiat, cryptocurrency, stock, ETF
- `scheduleTypes` - Income allocation, subscription, payment
- `scheduleStepTypes` - Inflow, outflow, transfer, conversion

**Core Entities:**
- `users` - User accounts with base currency preference
- `institutions` - Financial institutions (banks, exchanges, wallets)
- `accounts` - User's financial accounts linked to institutions
- `tokens` - Tradeable assets (stocks, crypto, fiat currencies)
- `holdings` - Asset positions in accounts with quantity and cost basis
- `tokenPrices` - Historical price data for assets
- `schedules` - Recurring transaction patterns with cron expressions
- `userWallets` - Blockchain wallet addresses for crypto tracking
- `integrationCredentials` - Encrypted API keys for external services

**Features:**
- UUID primary keys with `defaultRandom()`
- Automatic timestamps (`createdAt`, `updatedAt`)
- User scoping - All data automatically filtered by authenticated user
- Financial precision - Uses `Decimal.js` for all monetary calculations
- Foreign key relationships with proper cascading

### Database Migrations

```bash
# After schema changes in packages/infra/db/src/schema.ts
cd packages/infra/db
bun run db:generate    # Generate migration files
bun run db:migrate     # Apply migrations to database
bun run db:studio      # Visual database management
```

## 🔐 Authentication & Security

### Authentication Flow
- **Better-Auth** - session-based authentication with sessions stored in Postgres
- **Protected Procedures** - All user data access via `protectedProcedure`
- **User Scoping** - Automatic filtering of all queries by authenticated user
- **Admin Dashboard** - `apps/frontend/admin` uses a separate passkey flow gated by `ADMIN_SESSION_SECRET`; admin → api actions are HMAC-signed with `ADMIN_JOBS_HMAC_SECRET`

### Security Measures
- **Environment Variables** - All secrets stored in `.env.local` files (never committed)
- **Input Validation** - Zod schemas for all API inputs
- **SQL Injection Prevention** - Drizzle ORM parameterized queries only
- **Rate Limiting** - Per-endpoint and per-user rate limits
- **Error Sanitization** - Sensitive data removed from error responses

## 🔌 Integrations

### Financial Integrations
- **Plaid** - Bank and brokerage account linking (OAuth flow)
- **Binance** - Cryptocurrency exchange API integration
- **Kraken** - Cryptocurrency exchange API integration

### Blockchain Integrations
- **Ethereum** - ERC-20 token balances via Ethers.js
- **Bitcoin** - Bitcoin address balance tracking
- **Multi-chain support** - Extensible architecture for additional chains

### Data Providers
- **CoinGecko** - Cryptocurrency price data
- **DefiLlama** - DeFi protocol data and prices
- **Blockchain Explorers** - Balance and transaction data

### AI Integration
- **OpenAI GPT-4** - Screenshot parsing for quick data entry
- **Structured Outputs** - Type-safe AI responses with Zod validation

## 🤖 AI Features

### Screenshot Parsing
- Upload screenshots of holdings or transactions
- AI extracts structured data (token, quantity, price)
- Manual review and editing before saving
- Support for multiple assets per screenshot

### AI Chat Assistant
- Natural language schedule configuration
- Context-aware suggestions
- Integration with existing data

## 📱 Platform Support

### Web Application
- React 18 with TypeScript
- Vite for fast development
- Tailwind CSS + Shadcn UI components
- Responsive design for desktop and mobile browsers

## 🧪 Testing & Coverage

```bash
bun run test       # full repo suite — packages/ + apps/ via bunfig.toml preload
bun run coverage   # full suite + lcov.info + HTML report at coverage/html/index.html
```

Tests live in `tests/` next to `src/`, mirroring the source tree. The runner is `bun test`; preload is wired via root `bunfig.toml` (loads `reflect-metadata` + a default `DATABASE_URL` for repository tests). Repository tests wrap each body in a Postgres transaction via `withTestDb` and roll back on exit, so suites parallelize cleanly.

The coverage badge above is updated on every push to `main` by `.github/workflows/coverage.yml`, which uploads the line-coverage % to a GitHub Gist via [`Schneegans/dynamic-badges-action`](https://github.com/Schneegans/dynamic-badges-action). One-time setup:

1. Create a public gist (any starting filename) and copy its ID from the URL.
2. Generate a fine-grained GitHub PAT with the `gist` scope only.
3. Add it as repo **secret** `GIST_SECRET`.
4. Add the gist ID as repo **variable** `COVERAGE_GIST_ID`.
5. Replace `REPLACE_WITH_GIST_ID` in this README with the actual gist ID.

## 🚀 Deployment

Scani ships to a managed stack defined in code at `infra/terraform/` — that's the source of truth for Cloudflare / Fly / Neon / Upstash / GitHub. Don't click-configure in vendor dashboards.

### Production Targets

- **api + worker + data-provider** → Fly.io (Docker multi-stage Bun builds; `apps/backend/{api,worker,data-provider}/fly.toml`)
- **frontend/app, frontend/cloud, frontend/admin, frontend/landing** → Cloudflare Pages
- **Postgres** → Neon (serverless)
- **Redis** → Upstash (BullMQ)
- **Object storage** → Cloudflare R2
- **Email** → Fastmail (JMAP / SMTP)
- **Auth** → Better-Auth (sessions in Postgres)

CI/CD lives in `.github/workflows/`:
- `ci.yml` — lint, type-check, tests, secret scan
- `deploy-fly.yaml` — path-based change detection, DB migrations, deploys api/worker/data-provider to Fly and the four frontends to Cloudflare Pages. A `check-ci-status` job skips re-validation when the PR CI already passed.
- `terraform.yaml` — plan/apply for infra
- `backup-db.yaml` — scheduled DB backup

### Environment Variables

`.env.example` at the repo root documents all required variables for the three deployment tiers (OSS self-hosted with a local data-provider, semi-managed with Scani's hosted data-provider, and fully-managed SaaS on Fly+Neon+Upstash). Key groups:

- `DATABASE_URL` — Neon (prod) or local Postgres
- `REDIS_URL` — Upstash (prod) or local Redis
- `SCANI_CLOUD_URL` + `SCANI_CLOUD_API_KEY` — where api+worker reach the data-provider (`apps/backend/data-provider`) that owns every outbound third-party call
- `BETTER_AUTH_SECRET`, email config — auth
- Provider keys (`OPENAI_API_KEY`, `ETHERSCAN_API_KEY`, `COINGECKO_API_KEY`, `R2_*`, …) — live on the data-provider, not on api/worker
- `ADMIN_SESSION_SECRET` (admin passkey), `ADMIN_JOBS_HMAC_SECRET` (admin→api actions)

### Self-Hosting

See [`docs/SELF_HOST.md`](./docs/SELF_HOST.md) for the self-hosted deployment guide.

## 📖 Documentation

- [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) - Technical architecture details
- [`IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md) - Current implementation plan
- [`SELF_HOST.md`](./docs/SELF_HOST.md) - Self-hosting guide
- [`PUBLISHING.md`](./docs/PUBLISHING.md) - Release / publishing notes
- [`/docs/features/`](./docs/features/) - Feature-specific documentation
- [`/docs/technical/`](./docs/technical/) - Technical deep-dives

## 🤝 Contributing

### Development Workflow

1. Create a feature branch
2. Make changes following the architecture patterns
3. Run `bun lint:fix` to fix linting issues
4. Run `bun type-check` to verify TypeScript
5. Test functionality manually
6. Submit pull request with clear description

### Code Style

- Use **Biome** for linting and formatting
- Follow **clean architecture** principles (Use Cases → Services → Repositories)
- Use **TypeDI** for dependency injection
- Use **Decimal.js** for all financial calculations
- Use **Drizzle ORM** for all database operations
- Never use `require()` - always use ES6 imports

## 📄 License

[Your License Here]

## 🙏 Acknowledgments

Built with:
- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [tRPC](https://trpc.io/) - End-to-end type safety
- [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM
- [React](https://react.dev/) - UI framework
- [Better-Auth](https://better-auth.com/) - Authentication
- [BullMQ](https://bullmq.io/) - Async job queue
- [TypeDI](https://github.com/typestack/typedi) - Dependency injection

