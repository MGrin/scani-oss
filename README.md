# Scani - Personal Finance Management SaaS

A modern personal finance management application built with TypeScript, React, and tRPC.

## Tech Stack

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
- **tRPC** - End-to-end type safety
- **Zod** - Schema validation
- **Drizzle ORM** - Type-safe database queries
- **SQLite** - Development database
- **PostgreSQL** - Production database support
- **WebSocket** - Real-time updates
- **CORS** - Cross-origin resource sharing

### Development
- **Bun Workspaces** - Monorepo management
- **Shared Types** - Common type definitions
- **Drizzle Kit** - Database migrations and schema management
- **Bun Test** - Testing framework with 93%+ test coverage

## Project Structure

```
scani/
├── apps/
│   ├── backend/          # tRPC API server
│   └── frontend/         # React web application
├── packages/
│   └── shared/          # Shared types and utilities
└── package.json         # Workspace configuration
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- Node.js 18+ (for compatibility)

### Installation

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Set up the database**
   ```bash
   # Generate database migrations
   bun run db:generate
   
   # Apply database migrations
   bun run db:migrate
   
   # Seed the database with sample data
   bun run db:seed
   ```

3. **Start the backend**
   ```bash
   cd apps/backend
   bun dev
   ```
   The API server will start on `http://localhost:3001`
   WebSocket server will start on `ws://localhost:3002`

4. **Start the frontend** (in a new terminal)
   ```bash
   cd apps/frontend
   bun dev
   ```
   The web app will start on `http://localhost:5173`

### Development Commands

#### General Commands (from root directory):

- `bun dev` - Start both frontend and backend in development mode
- `bun build` - Build all packages
- `bun clean` - Clean all build artifacts
- `bun type-check` - Run TypeScript checks
- `bun test` - Run all tests
- `bun lint` - Run linting checks
- `bun format` - Format code with Biome.js

#### Database Commands:

- `bun run db:generate` - Generate database migrations from schema changes
- `bun run db:migrate` - Apply pending migrations to database
- `bun run db:seed` - Populate database with sample data
- `bun run db:setup` - Complete database setup (migrate + seed)
- `bun run db:studio` - Open Drizzle Studio for database management

## Database Architecture

Scani uses **Drizzle ORM** for type-safe database operations with support for both SQLite (development) and PostgreSQL (production).

### Database Schema

The application includes the following main entities:

- **Users** - User account information
- **Institutions** - Financial institutions (banks, brokers, etc.)
- **Accounts** - User's financial accounts (checking, savings, investment)
- **Tokens** - Tradeable assets (stocks, crypto, fiat currencies)
- **Holdings** - Asset positions in accounts
- **Transactions** - Financial transaction records
- **Token Prices** - Historical price data for assets

### Environment Configuration

- **Development**: Uses SQLite database stored in `./data/app.db`
- **Production**: Uses PostgreSQL via `DATABASE_URL` environment variable
- **Testing**: Uses in-memory SQLite database with isolated test data

### Database Operations

All database operations are:
- ✅ **Type-safe** with Drizzle ORM and TypeScript
- ✅ **Validated** using Zod schemas
- ✅ **Tested** with comprehensive test coverage
- ✅ **Migrated** using Drizzle Kit migration system
- ✅ **Seeded** with sample data for development

## Testing

Scani maintains **93%+ test coverage** across the entire codebase with comprehensive testing strategies:

### Test Types

- **Unit Tests** - Individual function and component testing
- **Integration Tests** - Database operations and API endpoints
- **Type Tests** - Schema validation and type safety
- **Financial Math Tests** - Precision calculations and edge cases

### Test Features

- ✅ **Database Isolation** - Each test uses fresh database state
- ✅ **Real Database Testing** - Tests use actual Drizzle ORM operations
- ✅ **Backend Coverage** - All routers, utilities, and schemas tested
- ✅ **Shared Package Coverage** - Financial math and type validation tested
- ✅ **Edge Case Handling** - Negative balances, precision, large numbers
- ✅ **Error Path Testing** - Validation errors and edge conditions
- ⚠️ **Frontend Testing** - Currently disabled (UI tests to be implemented later)

### Running Tests

```bash
# Run all tests
bun test

# Run tests with coverage report
bun test --coverage

# Run specific test file
bun test apps/backend/src/routers/accounts.test.ts
```

## Features

- 📊 **Dashboard** - Overview of financial status with real-time calculations
- 💳 **Account Management** - Track multiple accounts with full CRUD operations
- 🏦 **Institution Management** - Organize accounts by financial institutions
- 💰 **Holdings Tracking** - Monitor investment positions and balances
- 📝 **Transaction History** - Comprehensive transaction recording
- 🗃️ **Database Persistence** - Reliable SQLite/PostgreSQL data storage
- 📈 **Real-time Updates** - Live data synchronization
- 🎨 **Modern UI** - Clean, responsive design with Shadcn UI
- 🔒 **Type Safety** - Full TypeScript coverage with Drizzle ORM
- ✅ **High Test Coverage** - 93%+ test coverage with comprehensive test suite

## Future Enhancements

- 🔐 **Authentication** - User accounts and security
- 📱 **Mobile App** - React Native mobile version
- 🏦 **Bank Integration** - Connect to banking APIs
- 📊 **Advanced Analytics** - Charts and insights
- 💡 **Budget Planning** - Budget creation and tracking
