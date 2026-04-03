# Core Package Architecture

## Overview

The `@scani/core` package contains all reusable business logic, database schemas, and core infrastructure that can be shared across multiple applications (backend API, telegram bot, and future apps).

## Package Structure

```
packages/core/
├── src/
│   ├── config/              # Configuration files
│   │   └── pricing.ts       # API key configuration for pricing providers
│   ├── database/            # Database layer
│   │   ├── schema.ts        # Drizzle ORM schema definitions
│   │   ├── connection.ts    # Database connection setup
│   │   ├── migrations/      # Database migration files
│   │   └── index.ts         # Database exports
│   ├── domain/              # Domain entities
│   │   └── entities/        # Entity type definitions
│   ├── repositories/        # Data access layer
│   │   ├── BaseRepository.ts
│   │   ├── AccountRepository.ts
│   │   ├── HoldingRepository.ts
│   │   ├── TokenRepository.ts
│   │   ├── UserRepository.ts
│   │   └── ...             # Other repositories
│   ├── services/            # Business logic services
│   │   ├── BaseService.ts
│   │   ├── AccountService.ts
│   │   ├── HoldingService.ts
│   │   ├── PricingService.ts
│   │   └── ...             # Other services
│   ├── use-cases/           # Application use cases
│   │   ├── CreateHoldingUseCase.ts
│   │   ├── ImportWalletAddressUseCase.ts
│   │   ├── UpdateTokenPricesUseCase.ts
│   │   └── ...             # Other use cases
│   ├── external-services/   # External API integrations
│   │   ├── ai/              # AI provider integrations
│   │   ├── blockchain/      # Blockchain service integrations
│   │   └── pricing/         # Price data providers
│   ├── utils/               # Utility functions
│   │   └── logger.ts        # Logging utilities
│   ├── lib/                 # Library integrations
│   │   └── supabase.ts      # Authentication
│   └── index.ts             # Main package exports
├── package.json
├── tsconfig.json
└── drizzle.config.ts        # Database migration configuration
```

## Usage

### In Backend Application

```typescript
// Import services
import { AccountService, HoldingService } from '@scani/core/services';

// Import use cases
import { ImportWalletAddressUseCase } from '@scani/core/use-cases';

// Import repositories
import { TokenRepository } from '@scani/core/repositories';

// Import database
import { db, schema } from '@scani/core/database';

// Import entities (types)
import type { Account, Holding, Token } from '@scani/core';

// Import utilities
import { createComponentLogger } from '@scani/core/utils/logger';
```

### In Telegram Bot

```typescript
// Import services and use cases
import {
  ParseScreenshotUseCase,
  HoldingService,
  BlockchainServiceManager,
} from '@scani/core';

// Import repositories
import { TokenRepository } from '@scani/core/repositories';
```

## Database Migrations

Database migrations are managed in the core package:

```bash
# Generate a new migration after schema changes
cd packages/core
bun run db:generate

# Apply migrations (user action required)
cd packages/core
bun run db:migrate

# Open Drizzle Studio to inspect database
cd packages/core
bun run db:studio
```

The backend application's `drizzle.config.ts` now points to the core package for convenience, but migrations should be managed from the core package directly.

## Key Design Principles

1. **Clean Architecture**: Core business logic is separated from presentation layer and server infrastructure
2. **Dependency Injection**: Uses TypeDI for service and repository management
3. **Type Safety**: End-to-end TypeScript type safety with shared types
4. **Reusability**: All core logic can be reused across multiple applications
5. **Single Responsibility**: Each layer has a clear, focused responsibility

## What Stays in apps/backend

- Server setup (Elysia, CORS, rate limiting)
- Presentation layer (tRPC routers, middleware)
- WebSocket real-time updates service
- Cron job scheduling
- Server-specific configuration

## Benefits

- **Code Reuse**: Services, use cases, and repositories can be used in multiple apps
- **Better Testing**: Core logic can be tested independently of server infrastructure
- **Easier Maintenance**: Clear separation of concerns makes code easier to understand and modify
- **Scalability**: Easy to add new applications that use the same core logic
- **Type Safety**: Shared types ensure consistency across all applications
