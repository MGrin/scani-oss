# Use Cases

## Overview

Use cases represent **complete business workflows** that orchestrate multiple services to accomplish a specific user goal. They are the entry point for complex operations in the application layer.

## Purpose

Use cases serve to:
1. **Orchestrate services** - coordinate multiple services to complete a workflow
2. **Encapsulate business rules** - contain the logic for when and how to call services
3. **Simplify routers** - keep routers thin by moving complex workflows here
4. **Improve testability** - easier to test complete workflows in isolation

## Pattern

```typescript
import { Service } from 'typedi';

@Service()
export class MyUseCase {
  constructor(
    private readonly service1: Service1,
    private readonly service2: Service2,
    private readonly repository1: Repository1
  ) {}

  async execute(input: InputDTO): Promise<OutputDTO> {
    // 1. Validate input
    // 2. Orchestrate services
    // 3. Handle complex logic
    // 4. Return result
  }
}
```

## When to Create a Use Case

Create a use case when:
- ✅ The workflow involves **multiple services**
- ✅ There's **complex orchestration logic**
- ✅ The operation is a **complete business workflow** (e.g., "Import Wallet", "Parse Screenshot")
- ✅ The router method is getting **too large** (>50 lines)

Don't create a use case when:
- ❌ It's a simple CRUD operation
- ❌ It only calls one service method
- ❌ The logic is trivial

## Example Use Cases

### ImportWalletUseCase
Orchestrates the complete wallet import process:
1. Detect wallet address type (EVM/Bitcoin/Solana/etc.)
2. Fetch balances from blockchain services
3. Create institutions, accounts, holdings atomically
4. Validate tokens with pricing service
5. Return summary

### ParseScreenshotUseCase
Handles screenshot parsing workflow:
1. Validate image and user permissions
2. Call AI service to parse screenshot
3. Validate discovered tokens
4. Check for duplicates
5. Return parsed holdings with validation results

### CalculatePortfolioValueUseCase
Computes complete portfolio valuation:
1. Get user's base currency
2. Fetch all holdings
3. Batch fetch prices for all tokens
4. Calculate values with currency conversion
5. Return portfolio summary

## Usage in Routers

### Before (Fat Router)
```typescript
// 150 lines of complex logic directly in router
create: protectedProcedure.mutation(async ({ input, ctx }) => {
  const userId = getUserId(ctx);
  
  // Detect address type
  const addressType = detectAddressType(input.walletAddress);
  
  // Fetch balances from multiple chains
  const balances = await multiChainService.getBalances(...);
  
  // Create institutions
  const institution = await db.transaction(async (trx) => {
    // ... complex database logic
  });
  
  // Create accounts and holdings
  // ... 100 more lines of orchestration
  
  return result;
});
```

### After (Thin Router with Use Case)
```typescript
import { Container } from 'typedi';
import { ImportWalletUseCase } from '../application/use-cases/ImportWalletUseCase';

create: protectedProcedure.mutation(async ({ input, ctx }) => {
  const userId = getUserId(ctx);
  const useCase = Container.get(ImportWalletUseCase);
  return await useCase.execute({ ...input, userId });
});
```

## Directory Structure

```
use-cases/
├── README.md                        # This file
├── ImportWalletUseCase.ts          # Wallet import workflow
├── ParseScreenshotUseCase.ts       # Screenshot parsing workflow
├── CalculatePortfolioValueUseCase.ts  # Portfolio valuation
├── BatchCreateHoldingsUseCase.ts   # Batch holdings creation
└── ...                             # Other use cases
```

## Testing

Use cases are highly testable:

```typescript
describe('ImportWalletUseCase', () => {
  let useCase: ImportWalletUseCase;
  let mockWalletService: WalletService;
  
  beforeEach(() => {
    Container.reset();
    // Mock dependencies
    mockWalletService = {
      importWalletAddress: jest.fn()
    };
    Container.set(WalletService, mockWalletService);
    
    useCase = Container.get(ImportWalletUseCase);
  });
  
  it('should import wallet successfully', async () => {
    const result = await useCase.execute({
      walletAddress: '0x123...',
      userId: 'user1'
    });
    
    expect(result.success).toBe(true);
    expect(mockWalletService.importWalletAddress).toHaveBeenCalled();
  });
});
```

## Best Practices

1. **Single Responsibility** - Each use case should represent ONE complete workflow
2. **Input/Output DTOs** - Use clear input and output types
3. **Error Handling** - Handle and transform errors appropriately
4. **Logging** - Log important steps for debugging
5. **Transactions** - Use database transactions for atomic operations
6. **Validation** - Validate inputs early
7. **Documentation** - Document the workflow steps

## Anti-Patterns

❌ **Don't** make use cases call other use cases (use services instead)
❌ **Don't** put CRUD operations in use cases (services are fine for that)
❌ **Don't** access repositories directly (use services)
❌ **Don't** make use cases too granular (that's what services are for)

## Migration Strategy

As we refactor large routers:
1. Identify complex workflows in routers
2. Extract to use case with proper dependencies
3. Update router to call use case
4. Test thoroughly
5. Remove old router logic

---

**Status:** Ready for use case implementation
**Next Steps:** Extract complex workflows from large routers (tokens.ts, transactions.ts, wallet.ts)
