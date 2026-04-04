# @scani/core

Core business logic, database schemas, and shared infrastructure for Scani Finance.

## Overview

This package contains all reusable components that are shared across multiple Scani applications:
- **Backend API** (`apps/backend`)
- **Mobile App** (`apps/mobile`)
- Future applications

## What's Inside

- **Database Layer**: Drizzle ORM schemas, migrations, and connection management
- **Repositories**: Data access layer with clean abstractions
- **Services**: Business logic services for accounts, holdings, tokens, pricing, etc.
- **Use Cases**: Application-specific use cases implementing business workflows
- **External Services**: Integrations with AI, blockchain, and pricing providers
- **Utilities**: Shared logging, error tracking, and authentication utilities

## Installation

This package is part of the Scani monorepo and uses workspace dependencies:

```bash
# From the root of the monorepo
bun install
```

## Usage

Import from the package using the exported modules:

```typescript
// Services
import { AccountService, HoldingService } from '@scani/core/services';

// Use Cases
import { ImportWalletAddressUseCase } from '@scani/core/use-cases';

// Repositories
import { TokenRepository } from '@scani/core/repositories';

// Database
import { db } from '@scani/core/database';

// Types (entities are exported from database)
import type { Account, Holding } from '@scani/core';
```

## Database Management

### Generate Migrations

After making changes to `src/database/schema.ts`:

```bash
bun run db:generate
```

### Apply Migrations

```bash
bun run db:migrate
```

### Database Studio

Open Drizzle Studio to inspect your database:

```bash
bun run db:studio
```

## Development

### Type Checking

```bash
bun run type-check
```

### Linting

```bash
bun run lint
```

### Auto-fix Linting Issues

```bash
bun run lint:fix
```

## Architecture

This package follows clean architecture principles:

1. **Domain Layer** (`domain/`): Entity definitions
2. **Data Access Layer** (`repositories/`): Database operations
3. **Business Logic Layer** (`services/`): Core business logic
4. **Application Layer** (`use-cases/`): Application-specific workflows
5. **Infrastructure Layer** (`external-services/`, `database/`): External integrations

## Dependencies

Key dependencies:
- **drizzle-orm**: Type-safe ORM
- **postgres**: PostgreSQL client
- **typedi**: Dependency injection
- **decimal.js**: Precise decimal arithmetic for financial calculations
- **pino**: Fast logging
- **ethers**: Ethereum blockchain interactions
- **googleapis**: Google Sheets API integration

## Contributing

When adding new functionality to core:

1. Follow existing patterns (repositories, services, use cases)
2. Use TypeDI's `@Service()` decorator for dependency injection
3. Export new modules in `src/index.ts`
4. Add appropriate exports to `package.json`
5. Update type definitions as needed

## License

Private - Scani Finance
