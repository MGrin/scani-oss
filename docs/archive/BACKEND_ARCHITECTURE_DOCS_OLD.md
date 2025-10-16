# Scani Backend Architecture

## Overview

The Scani backend has been refactored to follow **Clean Architecture** principles with **Dependency Injection (DI)** using TypeDI. This architecture provides clear separation of concerns, testability, and maintainability.

## Architecture Layers

```
┌─────────────────────────────────────────────┐
│         Presentation Layer                   │
│  (HTTP/tRPC Routers, Middleware)            │
│  - Thin controllers                          │
│  - Input validation (Zod)                    │
│  - Response mapping                          │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│         Application Layer                    │
│  (Business Logic, Use Cases)                 │
│  - Services with business rules              │
│  - Transaction coordination                  │
│  - Complex workflows                         │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│         Domain Layer                         │
│  (Entities, DTOs, Interfaces)                │
│  - Pure business entities                    │
│  - Data transfer objects                     │
│  - Repository & service interfaces           │
└─────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│         Infrastructure Layer                 │
│  (Database, External Services)               │
│  - Repository implementations                │
│  - Database connections                      │
│  - External API clients                      │
└─────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── domain/                    # Domain Layer
│   ├── entities/             # Business entities (types from schema)
│   ├── dtos/                 # Data Transfer Objects
│   │   ├── user/
│   │   ├── token/
│   │   ├── institution/
│   │   ├── account/
│   │   ├── holding/
│   │   ├── transaction/
│   │   └── token-price/
│   └── interfaces/           # Contracts/Interfaces
│       ├── repositories/     # Repository interfaces
│       └── services/         # Service interfaces
│
├── infrastructure/           # Infrastructure Layer
│   ├── database/            # Database configuration
│   │   ├── connection.ts   # Database connection setup
│   │   └── schema.ts       # Drizzle ORM schema
│   └── repositories/        # Repository implementations
│       ├── BaseRepository.ts
│       ├── UserRepository.ts
│       ├── TokenRepository.ts
│       ├── TokenPriceRepository.ts
│       ├── InstitutionRepository.ts
│       ├── AccountRepository.ts
│       ├── HoldingRepository.ts
│       ├── TransactionRepository.ts
│       └── EnumRepositories.ts
│
├── application/             # Application Layer
│   ├── services/           # Business logic services
│   │   ├── BaseService.ts
│   │   ├── UserService.ts
│   │   ├── TokenService.ts
│   │   ├── TokenPriceService.ts
│   │   ├── InstitutionService.ts
│   │   ├── AccountService.ts
│   │   ├── HoldingService.ts
│   │   ├── TransactionService.ts
│   │   ├── WalletService.ts
│   │   ├── PricingService.ts
│   │   ├── PortfolioValuationService.ts
│   │   ├── TokenValidationService.ts
│   │   ├── BatchOperationsService.ts
│   │   └── EnumServices.ts
│   └── use-cases/          # Complex workflows (future)
│
├── presentation/            # Presentation Layer
│   ├── routers/            # tRPC routers (thin controllers)
│   │   ├── users.ts
│   │   ├── tokens.ts
│   │   ├── tokenPrices.ts
│   │   ├── institutions.ts
│   │   ├── accounts.ts
│   │   ├── holdings.ts
│   │   ├── transactions.ts
│   │   ├── wallet.ts
│   │   ├── screenshot-parsing.ts
│   │   ├── batch-operations.ts
│   │   └── *-types.ts     # Enum routers
│   └── middleware/         # HTTP middleware
│       └── auth.ts
│
├── config/                 # Configuration
│   └── container.ts       # DI container setup
│
└── utils/                  # Shared utilities
    └── logger.ts
```

## Key Design Principles

### 1. Dependency Injection (DI)

All services and repositories use **TypeDI** for dependency injection:

```typescript
@Service()
export class TokenService extends BaseService {
  constructor(
    private readonly tokenRepository: TokenRepository,
    private readonly tokenPriceRepository: TokenPriceRepository,
    private readonly tokenTypeRepository: TokenTypeRepository
  ) {
    super('TokenService');
  }
  
  async createToken(data: CreateTokenDto, userId: string): Promise<Token> {
    // Business logic here
    return await this.tokenRepository.create(data);
  }
}
```

**Benefits:**
- Easy to test (mock dependencies)
- Loose coupling
- Single Responsibility Principle
- Inversion of Control

### 2. Repository Pattern

All database access goes through repositories:

```typescript
@Service()
export class TokenRepository extends BaseRepository<Token, NewToken> {
  protected readonly table = schema.tokens;
  protected readonly tableName = 'tokens';

  async findBySymbol(symbol: string, tx?: DatabaseTransaction): Promise<Token | null> {
    const database = this.getDb(tx);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, symbol))
      .limit(1);
    return results[0] || null;
  }
}
```

**Benefits:**
- Centralized database logic
- Easy to swap database implementations
- Testable without database
- Transaction support

### 3. Service Layer

Business logic lives in services:

```typescript
@Service()
export class HoldingService extends BaseService {
  constructor(
    private readonly holdingRepository: HoldingRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly transactionTypeRepository: TransactionTypeRepository,
    private readonly accountRepository: AccountRepository
  ) {
    super('HoldingService');
  }

  async createHolding(data: CreateHoldingDto, userId: string): Promise<Holding> {
    return await this.withTransaction(async (tx) => {
      // Complex business logic with multiple operations
      const holding = await this.holdingRepository.create(data, tx);
      const openingBalanceType = await this.transactionTypeRepository.findByCode('opening_balance', tx);
      
      if (openingBalanceType && !new Decimal(data.balance).isZero()) {
        await this.transactionRepository.create({
          holdingId: holding.id,
          typeId: openingBalanceType.id,
          quantity: data.balance,
          date: new Date(),
          notes: 'Opening balance',
        }, tx);
      }
      
      return holding;
    });
  }
}
```

**Benefits:**
- Single place for business rules
- Atomic transactions
- Reusable logic
- Testable

### 4. Router Factory Pattern

Routers use factory functions for DI:

```typescript
export function createTokensRouter(
  db: Database,
  schema: Schema,
  tokenRepository: TokenRepository,
  tokenService: TokenService
) {
  return router({
    create: protectedProcedure
      .input(CreateTokenSchema)
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        return await tokenService.createToken(input, userId);
      }),
  });
}
```

**Main router:**
```typescript
const tokensRouter = createTokensRouter(
  db,
  schema,
  Container.get(TokenRepository),
  Container.get(TokenService)
);
```

**Benefits:**
- Testable routers
- Explicit dependencies
- No global state

## Data Flow

### 1. Request Flow

```
Client Request
    ↓
tRPC Router (Presentation)
    ↓ validates input (Zod)
    ↓ extracts userId
    ↓
Service (Application)
    ↓ business logic
    ↓ transaction management
    ↓
Repository (Infrastructure)
    ↓ database queries
    ↓
Database
```

### 2. Create Token Example

```typescript
// 1. Router receives request
createToken: protectedProcedure
  .input(CreateTokenSchema)
  .mutation(async ({ input, ctx }) => {
    const userId = getUserId(ctx);  // Extract user ID
    
    // 2. Delegate to service
    return await tokenService.createToken(input, userId);
  })

// 3. Service handles business logic
async createToken(data: CreateTokenDto, userId: string): Promise<Token> {
  this.validateRequiredFields(data, ['symbol']);
  
  // 4. Use repository for database operations
  return await this.withTransaction(async (tx) => {
    const token = await this.tokenRepository.create(data, tx);
    
    // Create price atomically for private tokens
    if (this.isPrivateToken(data.typeCode) && data.manualPrice) {
      await this.tokenPriceRepository.create({
        tokenId: token.id,
        price: data.manualPrice,
        // ...
      }, tx);
    }
    
    return token;
  });
}
```

## Transaction Management

### BaseService Transaction Support

```typescript
protected async withTransaction<T>(
  callback: (tx: Database) => Promise<T>
): Promise<T> {
  const db = getDb();
  
  try {
    this.logger.debug('Starting database transaction');
    
    const result = await db.transaction(async (tx) => {
      return await callback(tx);
    });
    
    this.logger.debug('Transaction completed successfully');
    return result;
  } catch (error) {
    this.logger.error({ error }, 'Transaction failed and was rolled back');
    throw error;
  }
}
```

**Usage in Services:**
```typescript
async createHolding(data: CreateHoldingDto, userId: string): Promise<Holding> {
  return await this.withTransaction(async (tx) => {
    const holding = await this.holdingRepository.create(data, tx);
    const transaction = await this.transactionRepository.create({...}, tx);
    return holding;
  });
}
```

## Error Handling

### Consistent Error Patterns

```typescript
// In BaseService
protected handleError(error: unknown, context: string): Error {
  if (error instanceof Error) {
    this.logger.error({ error, context }, `Error in ${context}`);
    return error;
  }
  
  const unknownError = new Error(`Unknown error in ${context}: ${String(error)}`);
  this.logger.error({ error, context }, `Unknown error in ${context}`);
  return unknownError;
}

// In Services
async createToken(data: CreateTokenDto, userId: string): Promise<Token> {
  try {
    // ... business logic
  } catch (error) {
    throw this.handleError(error, 'createToken');
  }
}
```

### Router Error Mapping

```typescript
try {
  return await service.performOperation(input, userId);
} catch (error) {
  if (error instanceof Error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: error.message,
    });
  }
  throw error;
}
```

## Testing Strategy

### Unit Testing Services

```typescript
describe('TokenService', () => {
  let tokenService: TokenService;
  let mockTokenRepository: jest.Mocked<TokenRepository>;
  let mockTokenPriceRepository: jest.Mocked<TokenPriceRepository>;

  beforeEach(() => {
    mockTokenRepository = createMockRepository();
    mockTokenPriceRepository = createMockRepository();
    
    tokenService = new TokenService(
      mockTokenRepository,
      mockTokenPriceRepository,
      mockTokenTypeRepository
    );
  });

  it('should create token with price atomically', async () => {
    const input = { symbol: 'TEST', manualPrice: '100', typeCode: 'private-company' };
    
    mockTokenRepository.create.mockResolvedValue({ id: '1', symbol: 'TEST' });
    
    const result = await tokenService.createToken(input, 'user-1');
    
    expect(result.symbol).toBe('TEST');
    expect(mockTokenPriceRepository.create).toHaveBeenCalled();
  });
});
```

### Integration Testing Routers

```typescript
describe('TokensRouter', () => {
  it('should create token via API', async () => {
    const caller = appRouter.createCaller({ user: mockUser });
    
    const result = await caller.tokens.create({
      symbol: 'TEST',
      name: 'Test Token',
      typeCode: 'stock',
    });
    
    expect(result.symbol).toBe('TEST');
  });
});
```

## Performance Considerations

### 1. Connection Pooling

```typescript
// infrastructure/database/connection.ts
const db = drizzle(postgres(DATABASE_URL, {
  max: 20,  // Connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
}));
```

### 2. Repository Caching

```typescript
// Example: Cache token lookups
private tokenCache = new Map<string, Token>();

async findBySymbol(symbol: string): Promise<Token | null> {
  if (this.tokenCache.has(symbol)) {
    return this.tokenCache.get(symbol)!;
  }
  
  const token = await this.database
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, symbol))
    .limit(1);
    
  if (token) {
    this.tokenCache.set(symbol, token);
  }
  
  return token || null;
}
```

### 3. Batch Operations

```typescript
// BatchOperationsService for bulk operations
async batchCreateHoldings(holdings: CreateHoldingDto[], userId: string) {
  return await this.withTransaction(async (tx) => {
    const results = await Promise.all(
      holdings.map(holding => 
        this.holdingService.createHolding(holding, userId, tx)
      )
    );
    return results;
  });
}
```

## Migration Notes

### From Old Architecture

**Before:**
```typescript
// Router with direct DB access
export const tokensRouter = router({
  create: protectedProcedure
    .input(schema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      
      // Direct database query in router ❌
      const [token] = await db
        .insert(schema.tokens)
        .values({ ...input, userId })
        .returning();
        
      return token;
    }),
});
```

**After:**
```typescript
// Factory function with DI
export function createTokensRouter(tokenService: TokenService) {
  return router({
    create: protectedProcedure
      .input(schema)
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        
        // Delegate to service ✅
        return await tokenService.createToken(input, userId);
      }),
  });
}
```

## Future Improvements

1. **Move ScreenshotParsingService to application/services** - Currently in services/ with direct DB access
2. **Standardize userId type** - Currently mixed string/number usage
3. **Add Use Cases layer** - For complex multi-service workflows
4. **Add Domain Events** - For decoupled communication between services
5. **Add CQRS pattern** - Separate read and write models for complex queries
6. **Add API versioning** - Support multiple API versions
7. **Add rate limiting** - Per-user rate limits for API endpoints
8. **Add request validation middleware** - Centralized validation logic

## Resources

- [TypeDI Documentation](https://github.com/typestack/typedi)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [tRPC Documentation](https://trpc.io/)
- [Clean Architecture by Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
