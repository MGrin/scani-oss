# Feature Registry System

## Overview

The Feature Registry is a centralized system that defines all user-facing features in Scani. It serves as a single source of truth for capabilities across different interfaces (UI, Telegram Bot, CLI).

## Architecture

```
packages/core/src/features/
└── index.ts                 # Feature registry and utilities
```

### Key Components

1. **Feature Definition** - Interface describing what a feature does and how to invoke it
2. **Feature Registry** - Collection of all available features organized by category
3. **Feature Categories** - Logical grouping of related features

## Feature Categories

The system organizes features into 9 main categories:

| Category | Count | Description |
|----------|-------|-------------|
| Dashboard | 2 | Portfolio overview and asset allocation |
| Accounts | 6 | Account management operations |
| Holdings | 4 | Holdings CRUD operations |
| Institutions | 5 | Institution management and queries |
| Tokens | 2 | Token search and listing |
| Wallet | 3 | Crypto wallet import operations |
| Batch Operations | 2 | Bulk data operations |
| Screenshots | 1 | AI-powered screenshot parsing |
| Settings | 4 | User preferences and settings |

**Total: 32 features**

## Feature Definition Structure

Each feature includes:

```typescript
interface Feature {
  id: string;                    // Unique identifier (e.g., "dashboard.getOverview")
  category: FeatureCategory;     // Category grouping
  name: string;                  // Human-readable name
  description: string;           // Detailed description for AI and docs
  procedurePath: string;         // tRPC procedure path
  inputSchema: z.ZodType<any>;   // Zod validation schema
  isMutation: boolean;           // Query vs mutation
  requiresAuth: boolean;         // Authentication requirement
  tags: string[];                // Search and filter tags
  examples?: string[];           // Usage examples
}
```

## Usage

### In Backend Routers

Features directly map to tRPC procedures:

```typescript
// Feature definition
{
  id: 'dashboard.getOverview',
  procedurePath: 'dashboard.getOverview',
  // ...
}

// Maps to tRPC router
dashboard: router({
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    // Implementation
  })
})
```

### In Telegram Bot

The bot dynamically generates tools from the feature registry:

```typescript
import { ALL_FEATURES } from '@scani/core/features';

// Tools are generated automatically
const tools = generateToolsFromFeatures();

// Users can query available tools with /tools command
```

### Tool Name Conversion

Feature IDs are converted to tool names using camelCase:

- `dashboard.getOverview` → `getDashboardOverview`
- `accounts.getById` → `getAccountsById`
- `holdings.delete` → `deleteHoldingsDelete`

The tool executor supports both the new generated names and legacy aliases for backward compatibility.

## Adding New Features

When adding a new user-facing feature:

1. **Add the backend tRPC procedure** in the appropriate router
2. **Define the feature** in `packages/core/src/features/index.ts`:

```typescript
{
  id: 'category.operation',
  category: FeatureCategory.CATEGORY,
  name: 'Operation Name',
  description: 'Detailed description for AI agents...',
  procedurePath: 'category.operation',
  inputSchema: z.object({ /* parameters */ }),
  isMutation: false, // or true
  requiresAuth: true,
  tags: ['tag1', 'tag2'],
  examples: ['Example usage 1', 'Example usage 2'],
}
```

3. **Add to feature array** (e.g., `CATEGORY_FEATURES`)
4. **Implement tool executor method** if needed (for telegram bot)

The feature will automatically be:
- Available in the telegram bot
- Listed in `/tools` command
- Documented with description and examples

## Benefits

1. **Single Source of Truth** - One place defines all capabilities
2. **Automatic Alignment** - UI and bot features stay in sync
3. **Self-Documenting** - Features include descriptions and examples
4. **Discoverable** - Users can query available tools via `/tools`
5. **Type-Safe** - Zod schemas ensure input validation
6. **Maintainable** - Easy to add, modify, or remove features

## Feature Discovery

### Search by Tags

```typescript
import { searchFeatures } from '@scani/core/features';

const portfolioFeatures = searchFeatures('portfolio');
```

### Get by Category

```typescript
import { getFeaturesByCategory, FeatureCategory } from '@scani/core/features';

const dashboardFeatures = getFeaturesByCategory(FeatureCategory.DASHBOARD);
```

### Get Category Summary

```typescript
import { getFeatureCategorySummary } from '@scani/core/features';

const summary = getFeatureCategorySummary();
// Returns: { category, count, features }[] for all categories
```

## Telegram Bot Integration

### Available Commands

- `/tools` - List all available tools organized by category
- `/help` - Show help message with examples
- Natural language queries work with all defined features

### Tool Execution Flow

1. User sends message to bot
2. AI agent analyzes message and selects appropriate tool
3. Tool executor maps tool name to feature
4. Feature's tRPC procedure is called with user context
5. Result is returned to user

### Special Tools

Some tools don't map directly to features but are computed:

- `getPortfolioByTokens` - Portfolio breakdown by tokens
- `getPortfolioByAccounts` - Portfolio breakdown by accounts
- `getPortfolioByInstitutions` - Portfolio breakdown by institutions
- `getPortfolioByTokenTypes` - Portfolio breakdown by token types
- `generatePortfolioChart` - Visual chart generation
- `get24hPriceChanges` - 24-hour price movement analysis

These are defined separately in `tools.ts` alongside feature-derived tools.

## Future Enhancements

Potential improvements to the feature system:

1. **Permission System** - Role-based feature access
2. **Feature Flags** - Toggle features on/off per environment
3. **Rate Limiting** - Per-feature rate limit definitions
4. **Analytics** - Track feature usage across interfaces
5. **Versioning** - Support multiple API versions
6. **CLI Generation** - Auto-generate CLI commands from features
7. **API Documentation** - Auto-generate API docs from features

## Testing

When testing features:

1. **Unit Tests** - Test feature definitions and utilities
2. **Integration Tests** - Test tRPC procedures mapped to features
3. **E2E Tests** - Test telegram bot tool execution
4. **Validation** - Ensure all features have valid procedure paths

## Maintenance

### Checklist for Feature Changes

When modifying features:

- [ ] Update feature definition in registry
- [ ] Update corresponding tRPC procedure
- [ ] Update tool executor if needed
- [ ] Test in telegram bot
- [ ] Update documentation
- [ ] Verify linter passes
- [ ] Check for breaking changes

### Breaking Changes

Breaking changes to features require:

1. Version the feature ID (e.g., `feature.v2`)
2. Maintain backward compatibility for old tool names
3. Update migration guide
4. Communicate to users

## Related Files

- `packages/core/src/features/index.ts` - Feature registry
- `apps/backend/src/presentation/router.ts` - Main tRPC router
- `apps/backend/src/presentation/routers/*.ts` - Individual routers
- `apps/telegram-bot/src/tools.ts` - Tool generation
- `apps/telegram-bot/src/tool-executor.ts` - Tool execution
- `apps/telegram-bot/src/bot.ts` - Bot commands
