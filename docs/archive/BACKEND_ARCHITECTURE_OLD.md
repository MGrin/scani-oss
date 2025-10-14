# Scani Backend Architecture

## Overview

The Scani backend follows a **layered clean architecture** (also known as onion/hexagonal architecture) with clear separation of concerns and dependency injection using TypeDI.

**Last Updated:** October 2024  
**Architecture Migration Status:** Phase 1-3 Complete ✅

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│                  Presentation Layer                  │
│              (routers/, index.ts, trpc.ts)           │
│              HTTP/WebSocket entry points             │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│                 Application Layer                    │
│                 (application/services/)              │
│        Business logic & workflow orchestration       │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│                   Domain Layer                       │
│                  (domain/entities/)                  │
│              Core business entities & types          │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│                Infrastructure Layer                  │
│   (infrastructure/database, repositories, etc.)      │
│     External services, database, WebSocket, etc.     │
└─────────────────────────────────────────────────────┘
```

### Dependency Rules

**Critical:** Dependencies flow **INWARD ONLY**
- ✅ Presentation → Application → Domain ← Infrastructure
- ❌ Domain should NOT depend on Infrastructure
- ❌ Application should NOT depend on Presentation

---

## Directory Structure

```
src/
├── application/
│   └── services/                    # Application services (business logic)
│       ├── PricingService.ts       # Token pricing & provider management
│       ├── PortfolioValuationService.ts  # Portfolio calculations
│       ├── UserContextService.ts    # User context & caching
│       ├── WalletService.ts        # Crypto wallet import
│       ├── ScreenshotParsingService.ts  # AI-powered parsing
│       ├── TokenService.ts         # Token CRUD operations
│       ├── HoldingService.ts       # Holdings management
│       ├── AccountService.ts       # Account operations
│       ├── TransactionService.ts   # Transaction handling
│       └── ...
│
├── domain/
│   └── entities/                    # Core domain entities
│       └── index.ts                # Token, Holding, Account types
│
├── infrastructure/
│   ├── database/
│   │   ├── connection.ts           # Database connection (Drizzle ORM)
│   │   └── schema.ts               # Database schema definitions
│   │
│   ├── repositories/                # Data access layer (Repository pattern)
│   │   ├── TokenRepository.ts
│   │   ├── HoldingRepository.ts
│   │   ├── AccountRepository.ts
│   │   ├── TransactionRepository.ts
│   │   └── EnumRepositories.ts
│   │
│   ├── external-services/           # External API integrations
│   │   ├── pricing/                # Pricing providers
│   │   │   ├── providers/
│   │   │   │   ├── coingecko.ts
│   │   │   │   ├── defillama.ts
│   │   │   │   ├── finnhub.ts
│   │   │   │   ├── exchange-rate.ts
│   │   │   │   └── google-sheets.ts
│   │   │   ├── provider-config.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   │
│   │   ├── blockchain/              # Blockchain services
│   │   │   ├── evm.ts
│   │   │   ├── bitcoin.ts
│   │   │   ├── solana.ts
│   │   │   ├── tron.ts
│   │   │   ├── multi-chain.ts
│   │   │   ├── etherscan.ts
│   │   │   └── ...
│   │   │
│   │   └── ai/                      # AI providers
│   │       ├── openai-provider.ts
│   │       ├── perplexity-provider.ts
│   │       ├── deepseek-provider.ts
│   │       ├── provider-manager.ts
│   │       └── types.ts
│   │
│   └── websocket/
│       └── RealTimeUpdatesService.ts  # WebSocket real-time updates
│
├── presentation/                     # [Future] Presentation layer
│   └── routers/                     # [Planned move]
│
├── routers/                         # API routers (tRPC)
│   ├── tokens.ts
│   ├── holdings.ts
│   ├── accounts.ts
│   ├── transactions.ts
│   ├── wallet.ts
│   ├── screenshot-parsing.ts
│   └── ...
│
├── config/                          # Configuration files
│   ├── chains.ts                   # Blockchain configurations
│   ├── pricing.ts                  # Pricing service config
│   └── container.ts                # TypeDI container setup
│
├── middleware/                      # Express/Elysia middleware
│   ├── auth.ts                     # Authentication middleware
│   └── rate-limit.ts               # Rate limiting
│
├── utils/                           # Utility functions
│   └── logger.ts                   # Logging utilities
│
├── scripts/                         # Utility scripts
│   └── clear-bad-prices.ts         # Maintenance scripts
│
├── index.ts                         # Application entry point
├── router.ts                        # Main tRPC router
└── trpc.ts                          # tRPC setup
```

---

## Dependency Injection

The application uses **TypeDI** for dependency injection.

### Service Registration

All services are decorated with `@Service()`:

```typescript
import { Service } from 'typedi';

@Service()
export class PricingService {
  constructor(
    private readonly tokenRepository: TokenRepository,
    private readonly tokenPriceRepository: TokenPriceRepository
  ) {}
}
```

### Service Usage

Use `Container.get()` to retrieve service instances:

```typescript
import { Container } from 'typedi';
import { PricingService } from './application/services/PricingService';

const pricingService = Container.get(PricingService);
const price = await pricingService.getTokenPrice(token, 'USD', new Date());
```

### Initialization

TypeDI container is initialized in `config/container.ts` and called at application startup:

```typescript
// index.ts
import { initializeContainer } from './config/container';

initializeContainer();
```

---

## Key Patterns

### 1. Repository Pattern

All database access goes through repositories:

```typescript
// ✅ Good: Use repository
const token = await tokenRepository.findBySymbol('BTC');

// ❌ Bad: Direct database query in service/router
const token = await db.select().from(tokens).where(eq(tokens.symbol, 'BTC'));
```

### 2. Service Layer

Business logic lives in services:

```typescript
// ✅ Good: Service handles business logic
const portfolioValue = await portfolioValuationService.getUserPortfolioValue(userId);

// ❌ Bad: Business logic in router
const holdings = await db.select()...
const prices = await pricingService.getTokenPrices()...
const totalValue = holdings.reduce()... // Complex calculation in router
```

### 3. Thin Routers

Routers should only:
- Validate input
- Call services
- Return responses

```typescript
// ✅ Good: Thin router
getAll: protectedProcedure.query(async ({ ctx }) => {
  const userId = getUserId(ctx);
  return await holdingService.getHoldingsByUserId(userId);
});

// ❌ Bad: Fat router with business logic
getAll: protectedProcedure.query(async ({ ctx }) => {
  const userId = getUserId(ctx);
  const holdings = await db.select()...  // Direct DB access
  const prices = await fetch()...        // External API call
  return holdings.map(h => ({            // Business logic
    ...h,
    value: parseFloat(h.balance) * prices[h.tokenId]
  }));
});
```

---

## Migration Status

### ✅ Completed (Phases 1-3)

1. **Infrastructure Layer Migration**
   - ✅ All external services moved to `infrastructure/external-services/`
   - ✅ Blockchain services properly organized
   - ✅ AI services properly organized
   - ✅ Pricing services properly organized

2. **Service Conversion to TypeDI**
   - ✅ All singleton patterns removed
   - ✅ Services use proper dependency injection
   - ✅ `Container.get()` used throughout

3. **Duplicate Code Elimination**
   - ✅ All duplicate files deleted
   - ✅ Old `src/services/` directory removed
   - ✅ Single source of truth for each service

### ⚠️ In Progress / Future Work (Phases 4-8)

4. **Router Consolidation** (Partially Complete)
   - ⚠️ Most routers use `Container.get()` ✅
   - ⚠️ Some routers still have direct DB access (tokens.ts, holdings.ts)
   - ⚠️ Large routers (tokens: 1224 lines) need refactoring

5. **Use Cases Layer** (Future)
   - 📋 Create `application/use-cases/` directory
   - 📋 Extract complex workflows:
     - `ImportWalletUseCase` - wallet import workflow
     - `ParseScreenshotUseCase` - screenshot parsing
     - `CalculatePortfolioValueUseCase` - portfolio calculations
     - `BatchCreateHoldingsUseCase` - batch operations

6. **Presentation Layer Organization** (Future)
   - 📋 Move routers to `presentation/routers/`
   - 📋 Move `router.ts` to `presentation/`
   - 📋 Move `trpc.ts` to `presentation/`

---

## Adding New Features

### Adding a New Service

1. Create service in `application/services/`:
```typescript
import { Service } from 'typedi';

@Service()
export class MyNewService {
  constructor(
    private readonly myRepository: MyRepository
  ) {}
  
  async doSomething() {
    // Business logic here
  }
}
```

2. Use TypeDI injection - no manual wiring needed!

### Adding a New Repository

1. Create repository in `infrastructure/repositories/`:
```typescript
import { Service } from 'typedi';

@Service()
export class MyRepository {
  async findById(id: string) {
    return await db.select().from(myTable).where(eq(myTable.id, id));
  }
}
```

### Adding a New Router

1. Create router in `routers/`:
```typescript
import { Container } from 'typedi';
import { MyService } from '../application/services/MyService';

export const myRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const service = Container.get(MyService);
    return await service.getAll();
  }),
});
```

2. Register in `router.ts`

---

## Testing Guidelines

### Unit Testing Services

```typescript
import { Container } from 'typedi';

describe('MyService', () => {
  let service: MyService;
  
  beforeEach(() => {
    Container.reset(); // Reset container between tests
    service = Container.get(MyService);
  });
  
  it('should do something', async () => {
    const result = await service.doSomething();
    expect(result).toBeDefined();
  });
});
```

### Integration Testing

Integration tests should use actual TypeDI container for realistic testing.

---

## Performance Considerations

1. **Rate Limiting**: External API calls use `RateLimiter` class
2. **Caching**: Price caching in database prevents redundant API calls
3. **Batch Operations**: Use batch methods like `getTokenPrices()` instead of individual calls
4. **Database Connection**: Single connection pool shared across all repositories

---

## Common Pitfalls

### ❌ Don't: Import from old locations
```typescript
// Wrong - this directory no longer exists!
import { pricingService } from '../services/pricing';
```

### ✅ Do: Use Container.get()
```typescript
import { Container } from 'typedi';
import { PricingService } from '../application/services/PricingService';

const pricingService = Container.get(PricingService);
```

### ❌ Don't: Direct database access in routers
```typescript
const holdings = await db.select().from(schema.holdings)...
```

### ✅ Do: Use services/repositories
```typescript
const holdings = await holdingService.getHoldingsByUserId(userId);
```

### ❌ Don't: Complex business logic in routers
```typescript
const totalValue = holdings.reduce((sum, h) => {
  const price = prices.get(h.tokenId);
  return sum.add(new Decimal(h.balance).mul(price));
}, new Decimal(0));
```

### ✅ Do: Delegate to services
```typescript
const portfolioValue = await portfolioValuationService.getUserPortfolioValue(userId);
```

---

## Resources

- **TypeDI Documentation**: https://github.com/typestack/typedi
- **Clean Architecture**: https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- **Repository Pattern**: https://martinfowler.com/eaaCatalog/repository.html
- **Drizzle ORM**: https://orm.drizzle.team/

---

## Questions or Issues?

If you encounter issues with the architecture:

1. Check this document first
2. Ensure you're using `Container.get()` for services
3. Verify imports are from correct locations
4. Make sure TypeDI container is initialized at startup

---

**Version:** 1.0.0  
**Last Migration Phase:** Phase 3 Complete (October 2024)
