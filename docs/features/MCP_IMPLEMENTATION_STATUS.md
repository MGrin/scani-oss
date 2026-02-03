# MCP Server Implementation Status

## ✅ Completed Work

### UPDATE (2026-01-30): Additional Completions

7. **Complete MCP Tool Implementations** ✅
   - Fully implemented all tools for: users, dashboard, accounts, holdings, tokens, institutions
   - All tools follow consistent patterns and include proper error handling
   - Tools directly call implementation layer, bypassing tRPC for efficiency

8. **MCP Server Integration** ✅
   - MCP endpoint mounted at `/mcp` in Elysia app
   - Authentication middleware integrated
   - Proper error handling and logging
   - Context management (set/clear) for request lifecycle

9. **Comprehensive Documentation** ✅
   - Created `docs/mcp-server.md` with full usage guide
   - Includes setup instructions for Claude Desktop, Cursor, and other clients
   - Complete tool reference with examples
   - Security best practices and troubleshooting guide

10. **Code Quality** ✅
    - All code linted and formatted with Biome
    - TypeScript types properly defined
    - Consistent error handling patterns

---

## ✅ Completed Work (Original)

### 1. Database Schema & Migration
- **File**: `packages/core/src/database/schema.ts`
- Added `api_keys` table with fields:
  - `id`, `userId`, `name`, `keyHash`, `keyPrefix`
  - `lastUsedAt`, `expiresAt`, `isActive`
  - `createdAt`, `updatedAt`
- Added indexes for performance
- Added relations to users table
- **Migration**: Generated at `packages/core/src/database/migrations/0030_shallow_oracle.sql`
- **Action Required**: Run `bun run db:migrate` when DATABASE_URL is configured

### 2. API Key Management (Backend Core)
- **Repository**: `packages/core/src/repositories/ApiKeyRepository.ts`
  - CRUD operations for API keys
  - Methods: `findByUserId`, `findActiveByPrefix`, `updateLastUsed`, `revoke`, `findByUserAndKeyId`
- **Service**: `packages/core/src/services/ApiKeyService.ts`
  - Key generation (format: `sk_live_<random>`)
  - Bcrypt hashing (10 rounds)
  - Key validation and authentication
  - Methods: `createApiKey`, `listApiKeys`, `revokeApiKey`, `validateApiKey`
- **Dependencies**: Added `bcryptjs` and `@types/bcryptjs` to packages/core

### 3. Shared DTOs
- **File**: `packages/shared/src/dtos/api-key.ts`
  - `CreateApiKeyDto`: name, expiresAt (optional)
  - `RevokeApiKeyDto`: id
  - Exported from `packages/shared/src/dtos/index.ts`

### 4. tRPC API Endpoints
- **File**: `apps/backend/src/presentation/routers/api-keys.ts`
  - `list`: Get all API keys for current user
  - `create`: Create new API key (returns plaintext key once)
  - `revoke`: Revoke/deactivate an API key
- **Integration**: Added to main router in `apps/backend/src/presentation/routers/router.ts` as `apiKeys` namespace

### 5. MCP Server Infrastructure
- **Dependencies**: Added `@modelcontextprotocol/sdk@1.25.3` to apps/backend
- **Authentication**: `apps/backend/src/infrastructure/mcp/auth.ts`
  - `authenticateMCPRequest`: Validates API key from Authorization header
  - Returns `MCPAuthContext` with userId
- **Server Setup**: `apps/backend/src/infrastructure/mcp/server.ts`
  - Creates McpServer instance
  - Auth context management
  - Tool registration framework

### 6. MCP Tool Implementations (Partial)
Created tool mappers for:
- **users**: `tools/users.ts` ✅ Complete
  - `users_getCurrent`, `users_updateCurrent`
  - `users_getSupportedCurrencies`, `users_getBaseCurrency`
- **dashboard**: `tools/dashboard.ts` ⚠️ Stub
  - `dashboard_getOverview`
- **tokens**: `tools/tokens.ts` ⚠️ Stub
  - `tokens_search`
- **accounts**: `tools/accounts.ts` ⚠️ Stub
  - `accounts_getAll`, `accounts_getById`
- **holdings**: `tools/holdings.ts` ⚠️ Stub
  - `holdings_getWithDetails`
- **institutions**: `tools/institutions.ts` ⚠️ Stub
  - `institutions_getAll`, `institutions_search`

## 🚧 Remaining Work

### 1. Complete MCP Tool Implementations

Each tool file needs to be expanded to cover all tRPC procedures from the corresponding router. Follow this pattern:

```typescript
server.tool(
  'namespace_methodName',  // Tool name: namespace from router, methodName from procedure
  'Description of what this tool does',  // Human-readable description
  {
    // Zod schema for input parameters - copy from tRPC procedure
    param1: z.string().describe('Parameter description'),
    param2: z.number().optional().describe('Optional parameter'),
  },
  async (params) => {
    const userId = getCurrentUserId();  // Get authenticated user
    
    // Call the implementation directly (bypass tRPC layer)
    const result = await SomeImplementation.method({ userId }, params);
    
    // Return MCP response format
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);
```

#### Tools to Complete:

1. **portfolio-history** (new file: `tools/portfolio-history.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/portfolio-history.ts`

2. **wallet** (new file: `tools/wallet.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/wallet.ts`

3. **screenshots** (new file: `tools/screenshots.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/screenshots.ts`

4. **batch-operations** (new file: `tools/batch-operations.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/batch-operations.ts`

5. **integrations** (new file: `tools/integrations.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/integrations.ts`

6. **account-types** (new file: `tools/account-types.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/account-types.ts`

7. **institution-types** (new file: `tools/institution-types.ts`)
   - Map procedures from `apps/backend/src/presentation/routers/institution-types.ts`

8. **Expand existing stub tools**:
   - `tools/dashboard.ts`: Add remaining dashboard procedures
   - `tools/tokens.ts`: Add `getById`, `getAllWithPrices`, etc.
   - `tools/accounts.ts`: Add `create`, `update`, `delete`, `getHoldings`, etc.
   - `tools/holdings.ts`: Add `update`, `delete`, `restore`, `updatePrice`, etc.
   - `tools/institutions.ts`: Add `getById`, `create`, etc.

### 2. Integrate MCP Server into Elysia App

**File**: `apps/backend/src/index.ts`

Add the following integration:

```typescript
import { mcpServer, registerAllTools, authenticateRequest, setAuthContext, clearAuthContext } from './infrastructure/mcp/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// After container initialization and before app.listen()

// Register all MCP tools
registerAllTools();

// Add MCP endpoint
app.post('/mcp', async ({ request, set }) => {
  try {
    // Authenticate the request using API key
    const authContext = await authenticateRequest(request);
    setAuthContext(authContext);

    // Create transport for this request
    const transport = new StreamableHTTPServerTransport();
    
    // Connect MCP server to transport
    await mcpServer.connect(transport);
    
    // Handle the request
    const response = await transport.handleRequest(request);
    
    // Clear auth context
    clearAuthContext();
    
    return response;
  } catch (error) {
    logger.error({ error }, 'MCP request failed');
    set.status = error.message.includes('Authentication') ? 401 : 500;
    clearAuthContext();
    return { error: error.message };
  }
});
```

**CORS Configuration**: Update CORS to allow MCP clients:
```typescript
.use(
  cors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'], // Add any MCP-specific headers
  })
)
```

**Rate Limiting**: Apply rate limiting to MCP endpoint (similar to existing tRPC rate limiting)

### 3. Frontend - API Key Management UI

Create React components in `apps/frontendV2/src/` (exact location depends on your frontend structure):

1. **ApiKeysList.tsx**
   - Display table/list of user's API keys
   - Show: name, keyPrefix (e.g., "sk_live_..."), lastUsedAt, expiresAt, isActive
   - Actions: Create new key, Revoke key
   - Use tRPC `apiKeys.list` query

2. **CreateApiKeyDialog.tsx**
   - Modal/dialog with form
   - Fields: name (required), expiresAt (optional date picker)
   - On submit: call tRPC `apiKeys.create` mutation
   - Show success with ApiKeyDisplay component

3. **ApiKeyDisplay.tsx**
   - One-time display of generated API key
   - Large text box with the full key
   - Copy to clipboard button
   - Warning message: "This key will only be shown once. Save it securely."
   - Close button

4. **RevokeApiKeyDialog.tsx**
   - Confirmation dialog
   - Warning: "Are you sure? This action cannot be undone."
   - On confirm: call tRPC `apiKeys.revoke` mutation

**Integration**: Add API key management section to user settings page

### 4. Testing

Create tests in `apps/backend/src/infrastructure/mcp/__tests__/`:

1. **api-key.test.ts**
   - Test key generation format
   - Test key hashing and verification
   - Test key validation (valid, expired, invalid)

2. **auth.test.ts**
   - Test `authenticateMCPRequest` with valid key
   - Test with invalid key, expired key, malformed header

3. **tools.test.ts**
   - Test each tool with valid input
   - Test authentication requirement
   - Test error handling

4. **integration.test.ts**
   - End-to-end test with MCP client
   - Test full request flow with authentication

### 5. Documentation

**File**: `docs/mcp-server.md`

Create comprehensive documentation:

#### Sections:
1. **Overview**
   - What is the Scani MCP server
   - Use cases (AI agents, automation, integrations)

2. **Getting Started**
   - How to create an API key through the UI
   - How to configure MCP client (Claude Desktop, Cursor, etc.)

3. **Authentication**
   - API key format
   - Header format: `Authorization: Bearer sk_live_<key>`
   - Security best practices

4. **Available Tools**
   - List all tools with descriptions and parameters
   - Example requests and responses
   - Error codes and handling

5. **Rate Limits**
   - Document rate limiting policies
   - How to handle rate limit errors

6. **Security**
   - Key storage recommendations
   - Key rotation guidelines
   - Revocation procedures

#### Example Client Configuration:

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "scani": {
      "url": "https://api.scani.finance/mcp",
      "headers": {
        "Authorization": "Bearer sk_live_your_api_key_here"
      }
    }
  }
}
```

**Cursor** (`.cursorrules`):
```
# Scani API MCP Server
MCP_SERVER_URL=https://api.scani.finance/mcp
MCP_API_KEY=sk_live_your_api_key_here
```

### 6. Additional Improvements (Optional)

1. **API Key Metadata**
   - Add `scopes` field to limit key permissions
   - Add `ipWhitelist` for IP-based restrictions

2. **Monitoring**
   - Track API key usage metrics
   - Alert on suspicious activity

3. **MCP Resources**
   - Implement MCP resources (read-only data) in addition to tools
   - Example: Expose account/holding data as resources

4. **Error Handling**
   - Standardize error responses
   - Add error codes for different failure scenarios

5. **Caching**
   - Cache frequently accessed data
   - Implement cache invalidation strategies

## Current File Structure

```
scani/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── database/
│   │       │   ├── schema.ts (✅ api_keys table added)
│   │       │   └── migrations/
│   │       │       └── 0030_shallow_oracle.sql (✅ generated)
│   │       ├── repositories/
│   │       │   └── ApiKeyRepository.ts (✅ complete)
│   │       └── services/
│   │           └── ApiKeyService.ts (✅ complete)
│   └── shared/
│       └── src/
│           └── dtos/
│               ├── api-key.ts (✅ complete)
│               └── index.ts (✅ exports added)
└── apps/
    └── backend/
        └── src/
            ├── infrastructure/
            │   └── mcp/
            │       ├── auth.ts (✅ complete)
            │       ├── server.ts (✅ complete)
            │       └── tools/
            │           ├── users.ts (✅ complete)
            │           ├── dashboard.ts (⚠️ stub)
            │           ├── tokens.ts (⚠️ stub)
            │           ├── accounts.ts (⚠️ stub)
            │           ├── holdings.ts (⚠️ stub)
            │           ├── institutions.ts (⚠️ stub)
            │           └── [more tools needed]
            ├── presentation/
            │   └── routers/
            │       ├── api-keys.ts (✅ complete)
            │       └── router.ts (✅ integrated)
            └── index.ts (❌ MCP endpoint integration needed)
```

## Quick Start for Completion

1. **Run the migration**:
   ```bash
   cd /Users/mgrin/Projects/mgrin/scani
   bun run db:migrate
   ```

2. **Complete the tool implementations** (follow the pattern in `tools/users.ts`)

3. **Integrate MCP into Elysia app** (see section 2 above)

4. **Build and test**:
   ```bash
   bun run lint:backend
   bun run type-check:backend
   ```

5. **Create frontend UI** for API key management

6. **Write documentation** in `docs/mcp-server.md`

7. **Test with an MCP client** (Claude Desktop or Cursor)

## Notes

- All database queries use Drizzle ORM
- Authentication uses bcrypt for API key hashing
- MCP SDK version: 1.25.3
- Follow existing code patterns (TypeDI, Biome formatting, etc.)
- The implementation uses Streamable HTTP transport (recommended by MCP SDK)
