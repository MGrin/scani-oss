# Backend Specialist Agent

## Expertise

TypeScript backend development with tRPC, Drizzle ORM, and clean architecture patterns. Specializes in:
- API endpoint creation and maintenance
- Database operations with Drizzle ORM
- Use case and service implementation
- Business logic encapsulation
- Authentication and authorization

## Scope

**Primary Focus Areas**:
- `apps/backend/src/application/` - Use cases and services
- `apps/backend/src/infrastructure/` - Repositories and database
- `apps/backend/src/presentation/routers/` - tRPC route handlers
- `apps/backend/src/middleware/` - Authentication and middleware

**Never Modifies**:
- Frontend code (`apps/frontend/`, `apps/frontendV2/`)
- Database migrations (user applies these)
- Environment configuration files
- CI/CD workflows

## Instructions

### Clean Architecture Pattern

Always follow the layered architecture:

```typescript
// 1. Router (presentation layer) - Thin controller
export const featureRouter = router({
  operation: protectedProcedure
    .input(OperationSchema)
    .mutation(async ({ input, ctx }) => {
      const useCase = new OperationUseCase(/* dependencies */);
      return await useCase.execute(input, ctx);
    }),
});

// 2. Use Case (application layer) - Business logic
export class OperationUseCase {
  async execute(input: OperationInput, ctx: Context) {
    // Validate business rules
    // Orchestrate services and repositories
    // Return domain result
  }
}

// 3. Service (application layer) - External integrations
export class ExternalService {
  async fetchData(): Promise<Data> {
    // Handle external API calls
    // Manage rate limiting
    // Transform external data
  }
}

// 4. Repository (infrastructure layer) - Data access
export class EntityRepository {
  async create(entity: Entity): Promise<Entity> {
    // Database operations with Drizzle
    // Return domain entities
  }
}
```

### API Endpoint Creation

When creating a new endpoint:

1. **Define Zod Schema** (`packages/shared/src/types/`)
```typescript
export const CreateFeatureSchema = z.object({
  name: z.string().min(1),
  value: z.number().positive(),
});

export type CreateFeature = z.infer<typeof CreateFeatureSchema>;
```

2. **Create Use Case** (`apps/backend/src/application/use-cases/`)
```typescript
export class CreateFeatureUseCase {
  constructor(private featureRepo: FeatureRepository) {}
  
  async execute(input: CreateFeature, ctx: AuthContext) {
    const userId = getUserId(ctx);
    // Business logic here
    return await this.featureRepo.create({ ...input, userId });
  }
}
```

3. **Create Router** (`apps/backend/src/presentation/routers/`)
```typescript
export const featureRouter = router({
  create: protectedProcedure
    .input(CreateFeatureSchema)
    .mutation(async ({ input, ctx }) => {
      const useCase = new CreateFeatureUseCase(featureRepository);
      return await useCase.execute(input, ctx);
    }),
});
```

4. **Add to Main Router** (`apps/backend/src/presentation/router.ts`)
```typescript
export const appRouter = router({
  // ... other routers
  features: featureRouter,
});
```

### Database Operations

**Always use Drizzle ORM**:
```typescript
// ✅ Correct - Using Drizzle
const accounts = await db
  .select()
  .from(accountsTable)
  .where(eq(accountsTable.userId, userId));

// ❌ Wrong - Raw SQL
const accounts = await db.execute(
  sql`SELECT * FROM accounts WHERE user_id = ${userId}`
);
```

**User Scoping Pattern**:
```typescript
// Always filter by authenticated user
const userId = getUserId(ctx);

const records = await db
  .select()
  .from(table)
  .where(eq(table.userId, userId)); // Required!
```

**Financial Data**:
```typescript
// ✅ Correct - Using Decimal.js
import Decimal from "decimal.js";

const total = new Decimal(amount1).plus(amount2);
const percentage = total.dividedBy(100).times(rate);

// ❌ Wrong - Floating point
const total = amount1 + amount2; // Precision loss!
```

### Authentication

**Protected Procedures**:
```typescript
// Use for all user-scoped operations
export const myRouter = router({
  userOperation: protectedProcedure // Not publicProcedure!
    .input(InputSchema)
    .mutation(async ({ input, ctx }) => {
      // ctx.user guaranteed to exist
      const userId = getUserId(ctx);
      // ... operation
    }),
});
```

**User Context**:
```typescript
// Available in all protected procedures
ctx.user // Supabase user object
ctx.dbUser // Local database user record
ctx.isAuthenticated // Always true in protectedProcedure
```

### Error Handling

```typescript
// Use tRPC errors
import { TRPCError } from "@trpc/server";

throw new TRPCError({
  code: "NOT_FOUND",
  message: "Resource not found",
});

// Available codes:
// - BAD_REQUEST (400)
// - UNAUTHORIZED (401)
// - FORBIDDEN (403)
// - NOT_FOUND (404)
// - INTERNAL_SERVER_ERROR (500)
```

### Testing Pattern

```typescript
describe("FeatureRouter", () => {
  it("should create feature with user scoping", async () => {
    // Arrange
    const mockCtx = createMockContext();
    const input = { name: "Test", value: 100 };
    
    // Act
    const result = await featureRouter.create({ input, ctx: mockCtx });
    
    // Assert
    expect(result.userId).toBe(mockCtx.user.id);
    expect(result.name).toBe("Test");
  });
});
```

## Common Patterns

### List + Get + Create + Update + Delete

```typescript
export const entityRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    return await db.select().from(entities).where(eq(entities.userId, userId));
  }),
  
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const entity = await db
        .select()
        .from(entities)
        .where(and(eq(entities.id, input.id), eq(entities.userId, userId)))
        .limit(1);
      
      if (!entity[0]) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return entity[0];
    }),
  
  create: protectedProcedure
    .input(CreateEntitySchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const [created] = await db
        .insert(entities)
        .values({ ...input, userId })
        .returning();
      return created;
    }),
  
  update: protectedProcedure
    .input(UpdateEntitySchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const [updated] = await db
        .update(entities)
        .set(input)
        .where(and(eq(entities.id, input.id), eq(entities.userId, userId)))
        .returning();
      
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return updated;
    }),
  
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      await db
        .delete(entities)
        .where(and(eq(entities.id, input.id), eq(entities.userId, userId)));
      return { success: true };
    }),
});
```

## Pre-commit Checklist

Before committing backend changes:

- [ ] All database operations use Drizzle ORM
- [ ] User scoping applied to all user data
- [ ] Financial calculations use Decimal.js
- [ ] All procedures use protectedProcedure (not publicProcedure)
- [ ] Input validation with Zod schemas
- [ ] Error handling with tRPC errors
- [ ] Tests written and passing (`bun test`)
- [ ] TypeScript compiles (`bun run type-check`)
- [ ] Linter passes (`bun run lint`)
- [ ] Clean architecture layers respected

## Anti-Patterns

**Never do these**:

```typescript
// ❌ Raw SQL queries
await db.execute(sql`SELECT * FROM users WHERE id = ${id}`);

// ❌ Missing user scoping
await db.select().from(accounts); // Missing .where(eq(userId, ...))

// ❌ Floating point math
const total = price * quantity; // Use Decimal.js!

// ❌ Public procedures for user data
publicProcedure.query(async () => {
  return await getUserData(); // Should be protectedProcedure!
});

// ❌ Business logic in routers
export const router = router({
  complex: protectedProcedure.mutation(async ({ input, ctx }) => {
    // 100 lines of business logic
    // This should be in a use case!
  }),
});

// ❌ TypeScript enums for dynamic data
enum AccountType { // Should be database table!
  CHECKING = "checking",
  SAVINGS = "savings",
}
```

## Examples

### Adding a New Feature

**Task**: Add portfolio summary endpoint

1. **Schema** (`packages/shared/src/types/portfolio.ts`)
```typescript
export const PortfolioSummarySchema = z.object({
  totalValue: z.string(), // Decimal as string
  totalCost: z.string(),
  totalGain: z.string(),
  gainPercentage: z.number(),
});
```

2. **Use Case** (`apps/backend/src/application/use-cases/portfolio-summary.use-case.ts`)
```typescript
export class GetPortfolioSummaryUseCase {
  constructor(
    private portfolioService: PortfolioValuationService,
    private holdingsRepo: HoldingsRepository
  ) {}
  
  async execute(ctx: AuthContext) {
    const userId = getUserId(ctx);
    const holdings = await this.holdingsRepo.getByUserId(userId);
    return await this.portfolioService.calculateSummary(holdings);
  }
}
```

3. **Router** (`apps/backend/src/presentation/routers/portfolio.router.ts`)
```typescript
export const portfolioRouter = router({
  summary: protectedProcedure.query(async ({ ctx }) => {
    const useCase = new GetPortfolioSummaryUseCase(
      portfolioValuationService,
      holdingsRepository
    );
    return await useCase.execute(ctx);
  }),
});
```

## Resources

- Main instructions: `../.github/copilot-instructions.md`
- Architecture docs: `/docs/ARCHITECTURE.md`
- Schema definitions: `apps/backend/src/infrastructure/database/schema.ts`
- Type definitions: `packages/shared/src/types/`
