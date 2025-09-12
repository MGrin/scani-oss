# Scani Project Rules

## Package Management

- Prefer `bunx` instead of `npx` for running packages in this Bun-based project
- Use `bun` for package management (install, add, remove, etc.)

## Financial Calculations

- Always use `decimal.js` and the `FinancialMath` utility class for all monetary computations
- Never use basic JavaScript math for financial calculations due to floating-point precision issues
- Import `FinancialMath` from `@scani/shared` for consistent financial operations

## Development Environment

- Backend uses Elysia server with tRPC
- Frontend uses React with Vite
- WebSocket integration for real-time updates
- Complex financial data model with hierarchical structure (User → Institution → Account → Holding → Transaction)

# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Scani is a personal finance management SaaS application built with TypeScript, React, and tRPC. It uses a modern Bun workspace monorepo structure with comprehensive test coverage (93%+) and type-safe APIs.

## Common Development Commands

### Root-Level Commands (run from project root)

```bash
# Development
bun dev                    # Start both frontend (http://localhost:5173) and backend (http://localhost:3001) concurrently
bun dev:backend           # Start only backend server with WebSocket on :3002
bun dev:frontend          # Start only frontend server

# Building
bun build                 # Build all workspaces (backend + frontend)
bun clean                 # Clean all build artifacts

# Code Quality
bun lint                  # Lint entire codebase with Biome
bun format               # Format entire codebase with Biome
bun type-check           # Run TypeScript checks across all workspaces
```

### Database Management Commands

```bash
# Database Schema & Migrations
bun run db:generate      # Generate Drizzle migrations from schema changes
bun run db:migrate       # Apply pending migrations to database
bun run db:setup        # Complete setup: migrate (for fresh installs)
bun run db:studio       # Open Drizzle Studio for database management
```

### Workspace-Specific Commands

When working in individual workspaces, `cd` into the specific directory first:

**Frontend (apps/frontend)**:

```bash
cd apps/frontend
bun dev                  # Start Vite dev server
bun build               # Build production bundle with TypeScript compilation
bun preview             # Preview production build locally
```

**Backend (apps/backend)**:

```bash
cd apps/backend
bun dev                 # Start Elysia server with hot reload
bun start               # Start production server
bun test                # Run backend-specific tests
```

**Shared Package (packages/shared)**:

```bash
cd packages/shared
bun test                # Run shared utilities tests
```

### Running Individual Tests

```bash
# Test specific files
bun test apps/backend/src/routers/accounts.test.ts
bun test packages/shared/src/utils/financial.test.ts

# Test specific workspace
bun run test:backend    # Backend tests only
bun run test:shared     # Shared package tests only
bun run test:frontend   # Frontend tests only (currently disabled)
```

## Architecture Overview

### Monorepo Structure

- **Bun Workspaces**: Root package.json manages workspace dependencies
- **apps/backend**: Elysia server with tRPC API and WebSocket support
- **apps/frontend**: React + Vite application with Shadcn UI components
- **packages/shared**: Type definitions and financial calculation utilities
- **data/**: SQLite database storage for development

### Technology Stack

**Backend**:

- **Elysia**: Modern TypeScript server framework
- **tRPC**: End-to-end type-safe API layer
- **Drizzle ORM**: Type-safe database queries with SQLite (dev) / PostgreSQL (prod)
- **WebSocket**: Real-time data synchronization
- **Zod**: Runtime schema validation

**Frontend**:

- **React 18**: UI framework with modern hooks
- **Vite**: Fast build tool and dev server
- **Tailwind CSS + Shadcn UI**: Modern component library
- **React Query**: Data fetching and caching via tRPC
- **React Router**: Client-side routing

**Development Tools**:

- **Biome**: Fast linting and formatting (replaces ESLint + Prettier)
- **Bun Test**: Native test framework with coverage reporting
- **TypeScript**: Strict type checking across entire codebase

### Database Schema Hierarchy

The application follows a hierarchical financial data model:

```
User
└── Institution (banks, brokers, etc.)
    └── Account (checking, savings, investment)
        └── Holding (token balances)
            └── Transaction (buy/sell/transfer records)

Token (tradeable assets: stocks, crypto, fiat)
└── TokenPrice (historical price data)
```

**Key Tables**:

- `users`: User account information and preferences
- `institutions`: Financial institutions (banks, brokers)
- `accounts`: User's financial accounts within institutions
- `tokens`: Tradeable assets (stocks, crypto, fiat currencies)
- `holdings`: Current token balances in each account
- `transactions`: Historical transaction records
- `token_prices`: Historical price data for asset valuation

## Financial Precision Requirements

**CRITICAL**: All monetary calculations must use `decimal.js` via the `FinancialMath` utility class from `@scani/shared`.

```typescript
import { FinancialMath } from "@scani/shared";

// Correct - use FinancialMath for all monetary operations
const totalValue = FinancialMath.multiply(balance, price);
const profit = FinancialMath.subtract(currentValue, costBasis);

// WRONG - never use basic JavaScript math for money
const totalValue = balance * price; // Precision issues!
```

**Database Storage**: Monetary values are stored as `real` (float) in SQLite but converted through Decimal.js to maintain precision across calculations.

## tRPC API Structure

The API is organized into domain-specific routers:

- `users`: User management
- `institutions`: Financial institution CRUD
- `accounts`: Account management within institutions
- `tokens`: Asset/token definitions
- `holdings`: Current balances and positions
- `transactions`: Transaction history
- `tokenPrices`: Historical pricing data

**Type Safety**: All API routes are fully typed from backend to frontend through tRPC, ensuring compile-time safety for API calls.

## Development Environment Setup

1. **Prerequisites**: Install [Bun](https://bun.sh/) (latest version)

2. **Initial Setup**:

   ```bash
   bun install
   bun run db:setup    # Sets up database with migrations and sample data
   ```

3. **Development Workflow**:
   ```bash
   bun dev             # Starts both servers concurrently
   # Backend: http://localhost:3001
   # Frontend: http://localhost:5173
   # WebSocket: ws://localhost:3002
   ```

## Environment Configuration

**Development**:

- Database: SQLite at `./data/app.db`
- Auto-seeded with sample data

**Production**:

- Database: PostgreSQL via `DATABASE_URL` environment variable
- Drizzle config automatically detects and switches database dialects

## Key Development Patterns

**Database Migrations**: Schema changes require generating migrations via `bun run db:generate` before applying with `bun run db:migrate`

**Type Sharing**: Database types are generated in `apps/backend/src/db/schema.ts` and shared across the application through workspace dependencies

**Financial Calculations**: Always import and use `FinancialMath` namespace from `@scani/shared` for any monetary operations

**API Development**: New API endpoints go in `apps/backend/src/routers/` with corresponding tests and automatic tRPC type generation

**WebSocket Integration**: Real-time updates use WebSocket server on port 3002 for live data synchronization
