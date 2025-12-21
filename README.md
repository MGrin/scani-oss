# Scani - Personal Finance Management SaaS

A comprehensive personal finance management platform built with modern TypeScript stack, featuring multi-platform support (web, mobile, Telegram bot) and extensive integrations with banks, brokerages, and cryptocurrency exchanges.

## 🌟 Features

### Core Capabilities
- **Multi-platform Access** - Web app, React Native mobile app, and Telegram bot
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
- **Error Tracking** - Sentry integration for both frontend and backend
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
- **PostgreSQL** - Primary database
- **Supabase** - Authentication and user management
- **WebSocket** - Real-time updates via custom WebSocket server
- **Sentry** - Error tracking and performance monitoring
- **Pino** - Structured logging
- **OpenAI** - AI integration for screenshot parsing and chat

### Integrations

- **Plaid** - Bank and brokerage account integration
- **Binance** - Cryptocurrency exchange integration
- **Kraken** - Cryptocurrency exchange integration
- **DefiLlama** - DeFi protocol data
- **Blockchain Explorers** - Ethereum, Bitcoin, and other blockchain data
- **CoinGecko** - Cryptocurrency price data

### Mobile

- **React Native** - Core framework
- **Ignite** - Battle-tested template for theming and internationalization
- **tRPC** - Type-safe API communication
- **WebSocket** - Real-time portfolio updates

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
│   ├── backend/              # tRPC API server with Elysia
│   │   ├── src/
│   │   │   ├── config/       # Container and configuration
│   │   │   ├── infrastructure/ # Cron jobs, Telegram, WebSocket
│   │   │   ├── presentation/  # tRPC routers and middleware
│   │   │   └── index.ts      # Application entry point
│   │   └── package.json
│   │
│   ├── frontendV2/           # React web application (main frontend)
│   │   ├── src/
│   │   │   ├── components/   # Reusable UI components
│   │   │   ├── contexts/     # React contexts (Auth, Theme)
│   │   │   ├── hooks/        # Custom React hooks
│   │   │   ├── lib/          # tRPC client setup
│   │   │   ├── pages/        # Route pages
│   │   │   └── main.tsx      # Application entry point
│   │   └── package.json
│   │
│   ├── landing/              # Marketing landing page
│   │   └── src/
│   │
│   ├── mobile/               # React Native mobile app (Ignite)
│   │   └── src/
│   │
│   └── telegram-bot/         # Telegram bot integration
│       └── src/
│
├── packages/
│   ├── core/                 # Core business logic
│   │   ├── src/
│   │   │   ├── database/     # Drizzle schema and connection
│   │   │   ├── use-cases/    # Business logic (18 use cases)
│   │   │   ├── services/     # Infrastructure services
│   │   │   ├── repositories/ # Data access layer
│   │   │   ├── entities/     # Domain entities
│   │   │   ├── features/     # Feature implementations
│   │   │   └── external-services/ # External API clients
│   │   └── package.json
│   │
│   ├── integrations/         # Integration framework
│   │   ├── src/
│   │   │   ├── implementations/ # Plaid, Binance, Kraken, etc.
│   │   │   ├── services/     # Integration API clients
│   │   │   └── IntegrationManager.ts
│   │   └── package.json
│   │
│   ├── rate-limiter/         # Rate limiting utilities
│   │   └── package.json
│   │
│   └── shared/               # Shared types and utilities
│       ├── src/
│       │   └── index.ts      # Zod schemas, Decimal.js helpers
│       └── package.json
│
├── docs/                     # Documentation
│   ├── ARCHITECTURE.md       # Technical architecture
│   ├── EXECUTIVE_SUMMARY.md  # Project status
│   ├── ROADMAP.md           # Development roadmap
│   ├── features/            # Feature documentation
│   ├── technical/           # Technical deep-dives
│   └── stability/           # Stability fixes and analysis
│
└── package.json             # Workspace root configuration
```

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest version recommended)
- PostgreSQL database (can use Supabase or local instance)
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
   cp apps/backend/.env.example apps/backend/.env.local
   ```

   Edit `apps/backend/.env.local` with your actual values:

   ```bash
   # Supabase Configuration (Required)
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your_supabase_anon_key_here
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here

   # Database Configuration (Required)
   # Use Supabase PostgreSQL or local PostgreSQL instance
   DATABASE_URL=postgresql://username:password@localhost:5432/scani_dev

   # Server Configuration (Optional)
   PORT=3001
   FRONTEND_URL=http://localhost:5173

   # External API Keys (Optional - for specific features)
   OPENAI_API_KEY=your_openai_api_key_here
   PLAID_CLIENT_ID=your_plaid_client_id
   PLAID_SECRET=your_plaid_secret
   ```

   **Frontend Environment Variables:**

   ```bash
   # Copy the example file and customize
   cp apps/frontendV2/.env.example apps/frontendV2/.env.local
   ```

   Edit `apps/frontendV2/.env.local` with your actual values:

   ```bash
   # Supabase Configuration (Required)
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here

   # API Configuration (Optional)
   VITE_API_URL=http://localhost:3001
   VITE_WS_URL=ws://localhost:3002

   # Sentry Configuration (Optional)
   VITE_SENTRY_DSN=your_sentry_dsn_here
   ```

3. **Set up Supabase Authentication**

   - Create a [Supabase](https://supabase.com) account and project
   - Enable Email/Password authentication in Supabase Dashboard
   - Copy your project URL and keys to the environment files
   - Configure your site URL in Supabase (e.g., `http://localhost:5173` for development)

4. **Set up the database**

   The application uses PostgreSQL for all data storage. You have two options:

   **Option A: Use Supabase PostgreSQL (Recommended)**

   ```bash
   # Use your Supabase database URL in the environment file
   # DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_ID].supabase.co:5432/postgres
   ```

   **Option B: Local PostgreSQL**

   ```bash
   # macOS with Homebrew
   brew install postgresql@15
   brew services start postgresql@15
   createdb scani_dev

   # Ubuntu/Debian
   sudo apt install postgresql
   sudo systemctl start postgresql
   sudo -u postgres createdb scani_dev

   # Set DATABASE_URL in your .env.local file
   # DATABASE_URL=postgresql://username:password@localhost:5432/scani_dev
   ```

   **Apply database migrations:**

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
   - Backend API server on `http://localhost:3001`
   - WebSocket server on `ws://localhost:3002`
   - Frontend web app on `http://localhost:5173`
   - Landing page on `http://localhost:5174`

   **Option 2: Start servers individually**
   ```bash
   # Terminal 1 - Backend
   bun dev:backend

   # Terminal 2 - Frontend
   bun dev:frontend

   # Terminal 3 - Landing page (optional)
   bun dev:landing
   ```

6. **Access the application**

   - Web App: `http://localhost:5173`
   - API Server: `http://localhost:3001`
   - Landing Page: `http://localhost:5174`

### Mobile Development

```bash
# iOS
bun dev:mobile:ios

# Android
bun dev:mobile:android
```

Prerequisites:
- iOS: macOS with Xcode installed
- Android: Android Studio with Android SDK

## 🛠️ Development Commands

### General Commands (from root):
- `bun dev` - Start all development servers (backend + frontendV2 + landing)
- `bun dev:backend` - Start backend server only
- `bun dev:frontend` - Start frontend web app only
- `bun dev:landing` - Start landing page only
- `bun build` - Build all packages for production
- `bun clean` - Clean all build artifacts

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
# Backend
cd apps/backend
bun dev              # Start with debug logging
bun dev:verbose      # Start with trace logging (includes SQL queries)
bun dev:quiet        # Start with minimal logging

# Frontend
cd apps/frontendV2
bun dev              # Start development server
bun build            # Build for production

# Mobile
cd apps/mobile
bun ios              # Run on iOS simulator
bun android          # Run on Android emulator
```

## 🏛️ Architecture Overview

### Clean Architecture Principles

Scani follows clean architecture with clear separation of concerns:

1. **Presentation Layer** (`apps/backend/src/presentation/`)
   - tRPC routers - Thin controllers that handle HTTP/WebSocket
   - Middleware - Authentication, rate limiting, logging
   - Type definitions and validation

2. **Use Case Layer** (`packages/core/src/use-cases/`)
   - Business logic encapsulation (18 use cases)
   - Single responsibility per use case
   - Reusable across different entry points

3. **Service Layer** (`packages/core/src/services/`)
   - Infrastructure services (Pricing, Portfolio Valuation, AI)
   - External API integrations
   - Complex calculations and aggregations

4. **Repository Layer** (`packages/core/src/repositories/`)
   - Data access abstraction
   - Database operations via Drizzle ORM
   - Query optimization

5. **Domain Layer** (`packages/core/src/entities/`)
   - Domain models and entities
   - Business rules and validations

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
# After schema changes in packages/core/src/database/schema.ts
cd packages/core
bun run db:generate    # Generate migration files
bun run db:migrate     # Apply migrations to database
bun run db:studio      # Visual database management
```

## 🔐 Authentication & Security

### Authentication Flow
- **Supabase Auth** - JWT-based authentication
- **User Sync** - Automatic sync from Supabase to local PostgreSQL
- **Protected Procedures** - All user data access via `protectedProcedure`
- **User Scoping** - Automatic filtering of all queries by authenticated user

### Security Measures
- **Environment Variables** - All secrets stored in `.env.local` files
- **Input Validation** - Zod schemas for all API inputs
- **SQL Injection Prevention** - Drizzle ORM parameterized queries only
- **Rate Limiting** - Per-endpoint and per-user rate limits
- **Error Sanitization** - Sensitive data removed from error responses
- **Sentry Integration** - Error tracking without exposing secrets

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

### Mobile Application
- React Native with Ignite template
- iOS and Android support
- Native navigation and theming
- Shared tRPC API client with web

### Telegram Bot
- Portfolio tracking via Telegram
- Daily digest notifications
- Quick balance checks
- Integration with main platform data

## 🧪 Testing Strategy

**Note:** The project currently does not require tests. Testing scripts can be created for development purposes but should be removed before final submission.

### Test Coverage (when tests exist)
- Backend routers and use cases
- Financial calculations (Decimal.js precision)
- Database operations (Drizzle ORM)
- Type validation (Zod schemas)

## 🚀 Deployment

### Production Build

```bash
# Build all packages
bun build

# Build specific package
cd apps/backend && bun run build
cd apps/frontendV2 && bun run build
```

### Environment Variables

Production requires the following environment variables:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - For AI features
- `PLAID_CLIENT_ID`, `PLAID_SECRET` - For bank integrations
- `SENTRY_DSN` - For error tracking

### Deployment Platforms

Recommended platforms:
- **Backend** - Fly.io, Railway, or any Node.js/Bun hosting
- **Frontend** - Vercel, Netlify, or Cloudflare Pages
- **Database** - Supabase, Neon, or managed PostgreSQL

## 📖 Documentation

- [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) - Technical architecture details
- [`EXECUTIVE_SUMMARY.md`](./docs/EXECUTIVE_SUMMARY.md) - Project status and overview
- [`ROADMAP.md`](./docs/ROADMAP.md) - Development roadmap and planned features
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
- [Supabase](https://supabase.com/) - Authentication and database
- [TypeDI](https://github.com/typestack/typedi) - Dependency injection

