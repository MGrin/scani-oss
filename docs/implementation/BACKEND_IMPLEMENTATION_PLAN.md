# Backend Refactoring - Implementation Plan

## 🎯 Current Status

### ✅ **COMPLETED**
- Phase 1: Infrastructure setup (TypeDI, decorators, container, directories)
- Phase 2: Domain layer (entities, DTOs, interfaces)  
- Phase 3.1: BaseRepository implementation
- Phase 3.3: TokenRepository implementation (with bug fixes)

### 📋 **REMAINING: 38 Phases**

---

## 🚀 **Next Steps** (In Order)

### **STEP 1**: Complete Repository Layer (8 files)

**Why**: Foundation for all data access. Must be done before services.

**Files to Create**:
1. `src/infrastructure/repositories/UserRepository.ts`
2. `src/infrastructure/repositories/TokenPriceRepository.ts`
3. `src/infrastructure/repositories/InstitutionRepository.ts`
4. `src/infrastructure/repositories/AccountRepository.ts`
5. `src/infrastructure/repositories/HoldingRepository.ts`
6. `src/infrastructure/repositories/TransactionRepository.ts`
7. `src/infrastructure/repositories/TokenTypeRepository.ts`
8. `src/infrastructure/repositories/EnumRepositories.ts` (all 4 enums in one file)

**Pattern** (same for all):
```typescript
import { Service } from 'typedi';
import { BaseRepository } from './BaseRepository';
import * as schema from '../database/schema';

@Service()
export class XRepository extends BaseRepository<X, NewX> implements IXRepository {
  protected readonly table = schema.xs;
  protected readonly tableName = 'xs';
  
  // Implement interface methods
}
```

### **STEP 2**: Create Services Layer (12 files)

**Critical Files** (implement these first with bug fixes):
1. `src/application/services/TokenService.ts` - FIX: Provider metadata bugs
2. `src/application/services/HoldingService.ts` - FIX: Atomic transaction creation

**Pattern**:
```typescript
import { Service } from 'typedi';

@Service()
export class XService {
  constructor(
    private readonly xRepo: XRepository
  ) {}
  
  // Business logic methods
}
```

### **STEP 3**: Refactor Existing Services (4 files)

Replace direct DB queries with repository calls in:
1. `src/services/pricing.ts` → `src/application/services/PricingService.ts`
2. `src/services/portfolio-valuation.ts` → `src/application/services/PortfolioValuationService.ts`
3. `src/services/token-validation.ts` → `src/application/services/TokenValidationService.ts`
4. Create `src/application/services/WalletService.ts`

### **STEP 4**: Refactor Routers (14 files)

Move from `src/routers/` to `src/presentation/routers/` and make thin:

**Pattern**:
```typescript
// Before: 
const result = await db.select().from...

// After:
const result = await this.xService.getX();
```

### **STEP 5**: Container & Integration

1. Register all in `src/config/container.ts`
2. Update `src/index.ts` to init container
3. Update all imports from `src/db/` to `src/infrastructure/database/`
4. Remove old `src/db/` directory

### **STEP 6**: Verification

```bash
bun run dev
# Test critical endpoints
# Verify no database queries in routers
# Verify all services use repositories
```

---

## 🔧 **Quick Copy-Paste Solutions**

### Example: Complete UserRepository

```typescript
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import type { User, NewUser, Token } from '../../domain/entities';
import type { IUserRepository, DatabaseTransaction } from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class UserRepository extends BaseRepository<User, NewUser> implements IUserRepository {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';

  async findByEmail(email: string, transaction?: DatabaseTransaction): Promise<User | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return results[0] || null;
  }

  async findWithBaseCurrency(userId: string, transaction?: DatabaseTransaction): Promise<User & { baseCurrency: Token | null } | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select({
        user: schema.users,
        baseCurrency: schema.tokens,
      })
      .from(schema.users)
      .leftJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(eq(schema.users.id, userId))
      .limit(1);
    
    if (!results[0]) return null;
    
    return {
      ...results[0].user,
      baseCurrency: results[0].baseCurrency,
    };
  }
}
```

### Example: Complete TokenService (with bug fixes)

```typescript
import { Service } from 'typedi';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import { TokenTypeRepository } from '../../infrastructure/repositories/TokenTypeRepository';
import type { CreateTokenInput, TokenResponseDto } from '../../domain/dtos/token';
import { db } from '../../infrastructure/database/connection';

@Service()
export class TokenService {
  constructor(
    private readonly tokenRepo: TokenRepository,
    private readonly tokenPriceRepo: TokenPriceRepository,
    private readonly tokenTypeRepo: TokenTypeRepository
  ) {}

  async createToken(input: CreateTokenInput): Promise<TokenResponseDto> {
    // CRITICAL BUG FIX: Use database transaction for atomic operation
    return await db.transaction(async (trx) => {
      // Get or validate token type
      const tokenType = await this.tokenTypeRepo.findByCode(input.typeCode!, trx);
      if (!tokenType) {
        throw new Error(`Token type '${input.typeCode}' not found`);
      }

      // CRITICAL BUG FIX: Properly structure provider metadata
      const providerMetadata = JSON.stringify({
        provider: input.providerMetadata?.provider || 'manual',
        [input.providerMetadata?.provider || 'manual']: input.providerMetadata,
        validatedAt: new Date().toISOString(),
      });

      // Create token
      const token = await this.tokenRepo.create({
        symbol: input.symbol,
        name: input.name || input.symbol,
        typeId: tokenType.id,
        decimals: input.decimals,
        iconUrl: input.iconUrl,
        providerMetadata,
        isActive: input.isActive,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, trx);

      // CRITICAL BUG FIX: Create initial price for private tokens atomically
      if (input.manualPrice) {
        const usdToken = await this.tokenRepo.findBySymbol('USD', trx);
        if (usdToken) {
          await this.tokenPriceRepo.create({
            tokenId: token.id,
            baseTokenId: usdToken.id,
            price: input.manualPrice.toString(),
            timestamp: new Date(),
            source: `manual - ${input.priceDescription || 'Initial price'}`,
            createdAt: new Date(),
          }, trx);
        }
      }

      return token;
    });
  }

  // ... more methods
}
```

---

## 📊 **Progress Tracking**

Use this checklist:

- [ ] 8 Repositories created
- [ ] 12 Services created
- [ ] 4 Existing services refactored
- [ ] 14 Routers refactored
- [ ] Container registered
- [ ] Entry point updated
- [ ] Database paths updated
- [ ] Old files removed
- [ ] Application starts
- [ ] Tests pass
- [ ] Token bugs fixed
- [ ] Holding bugs fixed

---

## 🎓 **Key Principles**

1. **Repositories**: Only database queries, no business logic
2. **Services**: Business logic, use repositories, return DTOs
3. **Routers**: Thin controllers, validate input, call services
4. **Always use @Service() decorator** for DI
5. **Use transactions** for atomic operations
6. **Log errors** at repository level
7. **Throw errors** up the chain

---

## 📞 **If Stuck**

1. Check import paths match new structure
2. Verify @Service() decorators present
3. Check Container.get() usage
4. Review logger imports
5. Test incrementally

---

## ⚡ **Fastest Path to Completion**

1. Copy BaseRepository pattern × 8 (repositories)
2. Copy TokenService pattern × 12 (services)
3. Thin all routers (find/replace pattern)
4. Update container
5. Test

**Estimated Time**: 3-4 hours of focused work

**Result**: Production-ready, fully layered, bug-free backend

END OF PLAN
