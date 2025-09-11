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
- **PostgreSQL** - Database (all environments)
- **Supabase** - Authentication and user management
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

1. **Clone the repository and install dependencies**

   ```bash
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

   # Server Configuration (Optional)
   PORT=3001
   FRONTEND_URL=http://localhost:5173

   # Database Configuration
   # PostgreSQL connection string (required for all environments)
   # You can use your Supabase database URL or a local PostgreSQL instance
   DATABASE_URL=postgresql://username:password@localhost:5432/scani_dev
   ```

   **Frontend Environment Variables:**

   ```bash
   # Copy the example file and customize
   cp apps/frontend/.env.example apps/frontend/.env.local
   ```

   Edit `apps/frontend/.env.local` with your actual values:

   ```bash
   # Supabase Configuration (Required)
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here

   # API Configuration (Optional)
   VITE_API_URL=http://localhost:3001
   ```

3. **Set up Supabase Authentication**

   - Create a [Supabase](https://supabase.com) account and project
   - Enable Email/Password authentication in Supabase Dashboard
   - Copy your project URL and keys to the environment files
   - Configure your site URL in Supabase (e.g., `http://localhost:5173` for development)

4. **Set up the database**

   The application now uses PostgreSQL for all environments except tests. You have two options:

   **Option A: Use Supabase PostgreSQL (Recommended)**

   If you're already using Supabase for authentication, you can use the same PostgreSQL database:

   ```bash
   # Use your Supabase database URL in the environment file
   # DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_ID].supabase.co:5432/postgres
   ```

   **Option B: Local PostgreSQL**

   Install and set up a local PostgreSQL instance:

   ```bash
   # macOS with Homebrew
   brew install postgresql
   brew services start postgresql
   createdb scani_dev

   # Set DATABASE_URL in your .env.local file
   # DATABASE_URL=postgresql://username:password@localhost:5432/scani_dev
   ```

   **Apply migrations:**

   ```bash
   # Generate database migrations (if schema changes)
   bun run db:generate

   # Apply database migrations
   bun run db:migrate
   ```

5. **Start the backend**

   ```bash
   cd apps/backend
   bun dev
   ```

   The API server will start on `http://localhost:3001`
   WebSocket server will start on `ws://localhost:3002`

6. **Start the frontend** (in a new terminal)
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
- `bun run db:setup` - Complete database setup (migrate)
- `bun run db:studio` - Open Drizzle Studio for database management

## Database Architecture

Scani uses **Drizzle ORM** for type-safe database operations with PostgreSQL for all environments.

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

- **All environments**: Use PostgreSQL via `DATABASE_URL` environment variable

The application requires a valid PostgreSQL connection string in the `DATABASE_URL` environment variable for all environments including development, testing, and production.For detailed PostgreSQL setup instructions, see [PostgreSQL Setup Guide](./docs/POSTGRESQL_SETUP.md).

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

## Security & Authentication

Scani implements secure authentication using **Supabase Auth** with the following features:

### Authentication Features

- ✅ **Email/Password Authentication** - Secure user registration and login
- ✅ **JWT Token-based Security** - All API endpoints are protected with JWT validation
- ✅ **Password Reset** - Email-based password reset functionality
- ✅ **Session Management** - Automatic token refresh and session persistence
- ✅ **User Data Isolation** - Each user only sees their own financial data
- ✅ **Route Protection** - Frontend routes require authentication
- ✅ **Environment Variables** - All secrets managed via environment variables

### Security Implementation

- **Backend Protection**: All tRPC procedures use `protectedProcedure` requiring valid JWT
- **Data Scoping**: Database queries automatically filter by authenticated user ID
- **Token Validation**: JWT tokens are validated on every API request
- **Secure Headers**: Authorization tokens sent via HTTP headers
- **No Hardcoded Secrets**: All sensitive data configured via environment variables

### Authentication Flow

1. **Registration**: Users create accounts via signup form with email validation
2. **Login**: Email/password authentication returns JWT access token
3. **API Requests**: Frontend automatically includes JWT in request headers
4. **Token Validation**: Backend validates JWT and extracts user information
5. **Data Access**: All data operations are scoped to the authenticated user
6. **Session Persistence**: Tokens are automatically refreshed and persisted

## Features

- � **Authentication** - Secure user accounts with Supabase Auth (email/password, password reset)
- �📊 **Dashboard** - Overview of financial status with real-time calculations
- 💳 **Account Management** - Track multiple accounts with full CRUD operations
- 🏦 **Institution Management** - Organize accounts by financial institutions
- 💰 **Holdings Tracking** - Monitor investment positions and balances
- 📝 **Transaction History** - Comprehensive transaction recording
- 🗃️ **Database Persistence** - Reliable SQLite/PostgreSQL data storage
- 📈 **Real-time Updates** - Live data synchronization
- 🎨 **Modern UI** - Clean, responsive design with Shadcn UI
- 🔒 **Type Safety** - Full TypeScript coverage with Drizzle ORM
- ✅ **High Test Coverage** - 93%+ test coverage with comprehensive test suite
- 🛡️ **Data Privacy** - User-scoped data access with secure JWT authentication

## Future Enhancements

- **Mobile App** - React Native mobile version
- 🏦 **Bank Integration** - Connect to banking APIs (Open Banking, Plaid)
- 📊 **Advanced Analytics** - Charts, trends, and insights
- 💡 **Budget Planning** - Budget creation and tracking
- 🔄 **Import/Export** - CSV/OFX file import and data export
- 📧 **Email Notifications** - Account alerts and reports
- 🌍 **Multi-currency** - Support for multiple currencies
- 📱 **Mobile-first UI** - Enhanced mobile experience
