# Migration Guide: Clean Architecture with DI

This guide helps developers understand and work with the new Clean Architecture implementation.

## Quick Start

### Adding a New Feature

Follow these steps when adding new functionality:

1. **Define DTOs** (if needed)
2. **Create/Update Repository** (for data access)
3. **Create/Update Service** (for business logic)
4. **Create/Update Router** (for API endpoint)
5. **Wire up DI** (register in container if new service/repository)

## Step-by-Step Examples

### Example 1: Adding a New Entity (e.g., "Category")

#### Step 1: Define Domain Entities

```typescript
// src/domain/entities/Category.ts
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type * as schema from '../../infrastructure/database/schema';

export type Category = InferSelectModel<typeof schema.categories>;
export type NewCategory = InferInsertModel<typeof schema.categories>;
```

#### Step 2: Create DTOs

```typescript
// src/domain/dtos/category/index.ts
export interface CreateCategoryDto {
  name: string;
  description?: string;
  userId: string;
}

export interface UpdateCategoryDto {
  name?: string;
  description?: string;
}

export interface CategoryResponseDto {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

#### Step 3: Create Repository

```typescript
// src/infrastructure/repositories/CategoryRepository.ts
import { Service } from 'typedi';
import { eq } from 'drizzle-orm';
import type { Category, NewCategory } from '../../domain/entities';
import type { DatabaseTransaction } from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class CategoryRepository extends BaseRepository<Category, NewCategory> {
  protected readonly table = schema.categories;
  protected readonly tableName = 'categories';

  async findByUserId(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Category[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.userId, userId))
        .orderBy(schema.categories.name);
      
      return results;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find categories by user');
      throw error;
    }
  }
}
```

#### Step 4: Create Service

```typescript
// src/application/services/CategoryService.ts
import { Service } from 'typedi';
import { BaseService } from './BaseService';
import { CategoryRepository } from '../../infrastructure/repositories/CategoryRepository';
import type { Category } from '../../domain/entities';
import type { CreateCategoryDto, UpdateCategoryDto } from '../../domain/dtos/category';

@Service()
export class CategoryService extends BaseService {
  constructor(
    private readonly categoryRepository: CategoryRepository
  ) {
    super('CategoryService');
  }

  async createCategory(
    data: CreateCategoryDto,
    userId: string
  ): Promise<Category> {
    try {
      this.logInfo('Creating category', { name: data.name, userId });
      
      this.validateRequiredFields(data, ['name']);
      this.validateNonEmptyString(data.name, 'name');

      const category = await this.categoryRepository.create({
        name: data.name,
        description: data.description || null,
        userId,
        isActive: true,
      });

      this.logInfo('Category created', { categoryId: category.id });
      return category;
    } catch (error) {
      throw this.handleError(error, 'createCategory');
    }
  }

  async updateCategory(
    categoryId: string,
    data: UpdateCategoryDto,
    userId: string
  ): Promise<Category> {
    try {
      this.logInfo('Updating category', { categoryId, userId });

      const existing = await this.categoryRepository.findById(categoryId);
      this.assertExists(existing, `Category with ID ${categoryId} not found`);

      if (existing.userId !== userId) {
        throw new Error('Unauthorized: Category does not belong to user');
      }

      const updated = await this.categoryRepository.update(categoryId, data);
      this.assertExists(updated, 'Failed to update category');

      this.logInfo('Category updated', { categoryId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateCategory');
    }
  }

  async getCategoriesByUser(userId: string): Promise<Category[]> {
    try {
      return await this.categoryRepository.findByUserId(userId);
    } catch (error) {
      throw this.handleError(error, 'getCategoriesByUser');
    }
  }

  async deleteCategory(categoryId: string, userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting category', { categoryId, userId });

      const existing = await this.categoryRepository.findById(categoryId);
      this.assertExists(existing, `Category with ID ${categoryId} not found`);

      if (existing.userId !== userId) {
        throw new Error('Unauthorized: Category does not belong to user');
      }

      const deleted = await this.categoryRepository.delete(categoryId);
      this.logInfo('Category deleted', { categoryId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteCategory');
    }
  }
}
```

#### Step 5: Create Router

```typescript
// src/routers/categories.ts
import { z } from 'zod';
import { getUserId } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';
import type { CategoryService } from '../application/services';

// Input validation schemas
const CreateCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
});

const UpdateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

/**
 * Factory function to create categories router with injected dependencies
 */
export function createCategoriesRouter(categoryService: CategoryService) {
  return router({
    // Get all categories for current user
    getAll: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);
      return await categoryService.getCategoriesByUser(userId);
    }),

    // Create a new category
    create: protectedProcedure
      .input(CreateCategorySchema)
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        return await categoryService.createCategory(input, userId);
      }),

    // Update a category
    update: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          data: UpdateCategorySchema,
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        return await categoryService.updateCategory(input.id, input.data, userId);
      }),

    // Delete a category
    delete: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        return await categoryService.deleteCategory(input.id, userId);
      }),
  });
}
```

#### Step 6: Wire Up in Main Router

```typescript
// src/router.ts
import { createCategoriesRouter } from './routers/categories';
import { CategoryService } from './application/services/CategoryService';

// ... other imports

// Create router instance
const categoriesRouter = createCategoriesRouter(
  Container.get(CategoryService)
);

// Add to app router
export const appRouter = router({
  // ... existing routers
  categories: categoriesRouter,
});
```

#### Step 7: Export Service (if new)

```typescript
// src/application/services/index.ts
export { CategoryService } from './CategoryService';
```

### Example 2: Adding a New Endpoint to Existing Router

Let's add a "search" endpoint to the tokens router:

#### Step 1: Add Method to Service

```typescript
// In TokenService.ts
async searchTokens(query: string, userId: string): Promise<Token[]> {
  try {
    this.logInfo('Searching tokens', { query, userId });
    
    this.validateNonEmptyString(query, 'query');
    
    // Use repository method
    return await this.tokenRepository.search(query);
  } catch (error) {
    throw this.handleError(error, 'searchTokens');
  }
}
```

#### Step 2: Add Method to Repository (if needed)

```typescript
// In TokenRepository.ts
async search(query: string, transaction?: DatabaseTransaction): Promise<Token[]> {
  try {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(
        or(
          ilike(schema.tokens.symbol, `%${query}%`),
          ilike(schema.tokens.name, `%${query}%`)
        )
      )
      .limit(20);
    
    return results;
  } catch (error) {
    this.logger.error({ query, error }, 'Failed to search tokens');
    throw error;
  }
}
```

#### Step 3: Add Endpoint to Router

```typescript
// In tokens.ts router
search: protectedProcedure
  .input(z.object({ query: z.string().min(1) }))
  .query(async ({ input, ctx }) => {
    const userId = getUserId(ctx);
    return await tokenService.searchTokens(input.query, userId);
  }),
```

## Common Patterns

### Pattern 1: User Authorization

Always verify the user owns the resource:

```typescript
async updateResource(resourceId: string, data: UpdateDto, userId: string) {
  const existing = await this.resourceRepository.findById(resourceId);
  this.assertExists(existing, `Resource with ID ${resourceId} not found`);

  // Verify ownership
  if (existing.userId !== userId) {
    throw new Error('Unauthorized: Resource does not belong to user');
  }

  return await this.resourceRepository.update(resourceId, data);
}
```

### Pattern 2: Atomic Transactions

Use `withTransaction` for multi-step operations:

```typescript
async complexOperation(data: CreateDto, userId: string) {
  return await this.withTransaction(async (tx) => {
    // All operations in same transaction
    const item1 = await this.repository1.create(data, tx);
    const item2 = await this.repository2.create({ itemId: item1.id }, tx);
    
    // If any fails, all rollback
    return { item1, item2 };
  });
}
```

### Pattern 3: Service Composition

Services can depend on other services:

```typescript
@Service()
export class OrderService extends BaseService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly paymentService: PaymentService,  // Service dependency
    private readonly emailService: EmailService       // Service dependency
  ) {
    super('OrderService');
  }

  async createOrder(data: CreateOrderDto, userId: string) {
    return await this.withTransaction(async (tx) => {
      const order = await this.orderRepository.create(data, tx);
      
      // Use other services
      await this.paymentService.processPayment(order.id, userId);
      await this.emailService.sendOrderConfirmation(order.id, userId);
      
      return order;
    });
  }
}
```

### Pattern 4: Optional vs Required Fields

Use proper DTO typing:

```typescript
// Create DTO - required fields
export interface CreateResourceDto {
  name: string;           // Required
  description?: string;   // Optional
  userId: string;         // Required
}

// Update DTO - all optional (partial update)
export interface UpdateResourceDto {
  name?: string;
  description?: string;
}
```

## Testing

### Unit Testing a Service

```typescript
import { TokenService } from '../TokenService';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';

// Mock the repository
jest.mock('../../infrastructure/repositories/TokenRepository');

describe('TokenService', () => {
  let service: TokenService;
  let mockRepository: jest.Mocked<TokenRepository>;

  beforeEach(() => {
    // Create mock instance
    mockRepository = new TokenRepository() as jest.Mocked<TokenRepository>;
    
    // Inject mock into service
    service = new TokenService(mockRepository);
  });

  it('should create a token', async () => {
    const input = { symbol: 'TEST', name: 'Test Token' };
    const expected = { id: '1', symbol: 'TEST', name: 'Test Token' };
    
    // Setup mock behavior
    mockRepository.create.mockResolvedValue(expected);
    
    // Call service
    const result = await service.createToken(input, 'user-1');
    
    // Verify
    expect(result).toEqual(expected);
    expect(mockRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'TEST' })
    );
  });
});
```

### Integration Testing a Router

```typescript
import { appRouter } from '../router';
import { createMockContext } from '../test/utils';

describe('Tokens Router', () => {
  it('should create token via API', async () => {
    const ctx = createMockContext({ userId: 'user-1' });
    const caller = appRouter.createCaller(ctx);
    
    const result = await caller.tokens.create({
      symbol: 'TEST',
      name: 'Test Token',
      typeCode: 'stock',
    });
    
    expect(result.symbol).toBe('TEST');
  });
});
```

## Troubleshooting

### Issue: "Cannot inject value into X"

**Problem:** TypeDI cannot resolve dependency.

**Solution:** 
1. Ensure class has `@Service()` decorator
2. Verify it's exported from index.ts
3. Check circular dependencies

```typescript
// Make sure service is decorated
@Service()
export class MyService extends BaseService {
  // ...
}

// And exported
// src/application/services/index.ts
export { MyService } from './MyService';
```

### Issue: "Transaction already committed"

**Problem:** Trying to use transaction after it's finished.

**Solution:** Use `withTransaction` wrapper:

```typescript
// ❌ Wrong
async badMethod(tx: Database) {
  const result = await this.repository.create(data, tx);
  // Transaction ends here
  return result;
}

// ✅ Correct
async goodMethod(data: CreateDto) {
  return await this.withTransaction(async (tx) => {
    const result = await this.repository.create(data, tx);
    // Transaction still active
    return result;
  });
}
```

### Issue: "Repository method not found"

**Problem:** Repository doesn't have the method you need.

**Solution:** Add it to the repository:

```typescript
// In YourRepository.ts
async findByCustomField(
  value: string,
  transaction?: DatabaseTransaction
): Promise<Entity[]> {
  try {
    const database = this.getDb(transaction);
    return await database
      .select()
      .from(this.table)
      .where(eq(this.table.customField, value));
  } catch (error) {
    this.logger.error({ value, error }, 'Failed to find by custom field');
    throw error;
  }
}
```

## Best Practices

### ✅ DO

1. **Keep routers thin** - Only validation and service calls
2. **Put business logic in services** - Not in routers or repositories
3. **Use transactions for multi-step operations** - `withTransaction`
4. **Validate user ownership** - Before updates/deletes
5. **Use DTOs for type safety** - Don't use raw types
6. **Log important operations** - Use `logInfo`, `logWarning`, etc.
7. **Handle errors consistently** - Use `handleError` method
8. **Write tests** - For services and complex logic

### ❌ DON'T

1. **Don't put database queries in routers** - Use repositories
2. **Don't put business logic in repositories** - Use services
3. **Don't use global service instances** - Use DI
4. **Don't skip validation** - Always validate inputs
5. **Don't expose internal errors** - Map to user-friendly messages
6. **Don't forget transactions** - For multi-step operations
7. **Don't mix userId types** - Standardize on string or number
8. **Don't commit directly** - Create PR for review

## Checklist for New Features

- [ ] DTOs created with proper types
- [ ] Repository has all needed methods
- [ ] Service implements business logic
- [ ] Router uses factory pattern
- [ ] Validation schemas defined (Zod)
- [ ] User authorization checked
- [ ] Errors handled properly
- [ ] Logging added for operations
- [ ] Transactions used if multi-step
- [ ] Service exported in index.ts
- [ ] Router wired up in main router
- [ ] Tests written
- [ ] Documentation updated

## Questions?

- Check the [Architecture Documentation](./ARCHITECTURE.md)
- Review existing implementations in `src/application/services/`
- Look at router examples in `src/routers/`
- Ask the team in Slack/Discord

## Additional Resources

- [TypeDI Container Documentation](https://github.com/typestack/typedi#basic-usage)
- [Drizzle ORM Query Examples](https://orm.drizzle.team/docs/select)
- [tRPC Procedures Guide](https://trpc.io/docs/server/procedures)
- [Zod Validation](https://zod.dev/)
