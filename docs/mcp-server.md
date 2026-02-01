# Scani MCP Server Documentation

## Overview

The Scani MCP (Model Context Protocol) server allows AI agents and tools like Claude Desktop, Cursor, and other MCP-compatible clients to interact with your Scani portfolio data programmatically.

### What is MCP?

The Model Context Protocol (MCP) is an open standard created by Anthropic that enables AI applications to securely connect to external data sources and tools. Think of it as a standardized API specifically designed for AI agents.

### Use Cases

- **AI-Powered Portfolio Analysis**: Let Claude or other AI assistants analyze your portfolio, suggest optimizations, or answer questions about your holdings
- **Automation**: Build scripts and automations that interact with your portfolio data
- **Integrations**: Connect Scani to other tools and services through MCP-compatible platforms
- **Custom AI Agents**: Build specialized AI agents that can manage and monitor your portfolio

## Getting Started

### Step 1: Create an API Key

1. Log into your Scani account
2. Navigate to **Settings** > **API Keys**
3. Click **Create New API Key**
4. Give your key a descriptive name (e.g., "Claude Desktop" or "Personal Automation")
5. (Optional) Set an expiration date for added security
6. Click **Create**

**⚠️ IMPORTANT**: The API key will only be shown once! Make sure to copy and save it securely. It will look like: `sk_live_...`

### Step 2: Configure Your MCP Client

#### Claude Desktop

Add the following to your Claude Desktop configuration file:

**Location**:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration**:

```json
{
  "mcpServers": {
    "scani": {
      "url": "https://api.scani.finance/mcp",
      "transport": {
        "type": "http",
        "headers": {
          "Authorization": "Bearer sk_live_YOUR_API_KEY_HERE"
        }
      }
    }
  }
}
```

Replace `sk_live_YOUR_API_KEY_HERE` with your actual API key.

#### Cursor

Add to your project's `.cursorrules` or workspace settings:

```
# Scani Portfolio API
MCP_SERVER_URL=https://api.scani.finance/mcp
MCP_API_KEY=sk_live_YOUR_API_KEY_HERE
```

#### Other MCP Clients

For other MCP-compatible clients, configure them to:

- **URL**: `https://api.scani.finance/mcp`
- **Transport**: HTTP/HTTPS
- **Authentication**: Add header `Authorization: Bearer sk_live_YOUR_API_KEY_HERE`

### Step 3: Test the Connection

In Claude Desktop or your MCP client, try asking:

- "What is my total portfolio value?"
- "Show me my holdings"
- "What are my top 5 assets by value?"

## Available Tools

The Scani MCP server exposes the following tools (organized by category):

### User & Settings

- `users_getCurrent` - Get current user profile
- `users_updateCurrent` - Update user profile (name, avatar, base currency)
- `users_getSupportedCurrencies` - List available fiat currencies
- `users_getBaseCurrency` - Get user's configured base currency

### Dashboard & Overview

- `dashboard_getOverview` - Get comprehensive portfolio overview (value, counts, top holdings, allocation)
- `dashboard_getAssetAllocation` - Get asset allocation by dimension (token, token_type, account, institution, etc.)

### Accounts

- `accounts_getAll` - List all accounts
- `accounts_getByUserIdWithSummary` - Get accounts with summary information
- `accounts_getById` - Get specific account details
- `accounts_getHoldings` - Get holdings for an account
- `accounts_update` - Update account details
- `accounts_delete` - Delete an account
- `accounts_bulkDelete` - Delete multiple accounts
- `accounts_bulkAssignGroups` - Assign groups to accounts
- `accounts_getCommonGroups` - Get common groups across accounts

### Holdings

- `holdings_getWithDetails` - Get all holdings with prices and details
- `holdings_update` - Update a holding
- `holdings_delete` - Delete a holding
- `holdings_bulkDelete` - Delete multiple holdings
- `holdings_restore` - Restore a hidden holding
- `holdings_updatePrice` - Force refresh price from providers
- `holdings_bulkAssignGroups` - Assign groups to holdings
- `holdings_getCommonGroups` - Get common groups across holdings

### Tokens

- `tokens_search` - Search for tokens by symbol or name
- `tokens_getAll` - List all available tokens

### Institutions

- `institutions_getAll` - List all institutions
- `institutions_getById` - Get institution details
- `institutions_search` - Search institutions by name

## Example Queries

### Portfolio Analysis

```
User: "What is my current portfolio worth and what are my top 3 holdings?"

The AI will call:
1. dashboard_getOverview - Get total value
2. holdings_getWithDetails - Get all holdings with values
```

### Account Management

```
User: "Show me all my bank accounts and their balances"

The AI will call:
1. accounts_getByUserIdWithSummary - Get accounts with summaries
2. Filter for bank account types
```

### Asset Allocation

```
User: "Break down my portfolio by institution"

The AI will call:
1. dashboard_getAssetAllocation(dimension: "institution")
```

### Price Updates

```
User: "Update the prices for all my crypto holdings"

The AI will call:
1. holdings_getWithDetails - Get all holdings
2. Filter for crypto holdings
3. holdings_updatePrice(id) - For each crypto holding
```

## Authentication

### API Key Format

API keys follow the format: `sk_live_<random>`

- Prefix: `sk_live_`
- Length: 40 characters total
- Random part: 32 characters (hex)

### Security Best Practices

1. **Store Securely**: Never commit API keys to version control
2. **Use Environment Variables**: Store keys in environment variables or secure config files
3. **Set Expiration**: Use expiration dates for keys that don't need permanent access
4. **Revoke Unused Keys**: Regularly audit and revoke keys that are no longer needed
5. **One Key Per Use Case**: Create separate keys for different tools/purposes
6. **Monitor Usage**: Check the "Last Used" timestamp to detect unauthorized access

### Revoking a Key

If you suspect a key has been compromised:

1. Go to **Settings** > **API Keys**
2. Find the key in the list
3. Click **Revoke**
4. Create a new key and update your MCP client configuration

## Rate Limits

The MCP endpoint shares the same rate limits as the standard API:

- **Global Limit**: 300 requests per 5 minutes per IP
- **MCP Endpoint**: 60 requests per minute for heavy operations

If you exceed rate limits, you'll receive a `429 Too Many Requests` response with a `Retry-After` header.

## Error Handling

### Common Errors

#### 401 Unauthorized

```json
{
  "error": "Authentication required",
  "message": "MCP request failed"
}
```

**Cause**: Invalid, expired, or missing API key
**Solution**: Check your API key and ensure it's correctly configured

#### 403 Forbidden

**Cause**: API key is valid but doesn't have permission for the requested resource
**Solution**: Ensure the resource belongs to your account

#### 429 Too Many Requests

```json
{
  "error": "Too Many Requests",
  "message": "MCP route rate limit exceeded",
  "retryAfterSec": 30
}
```

**Cause**: Rate limit exceeded
**Solution**: Wait for the specified time before retrying

#### 500 Internal Server Error

**Cause**: Server error during request processing
**Solution**: Check your request parameters and try again; contact support if the issue persists

## Advanced Usage

### Combining Multiple Tools

AI agents can intelligently chain multiple tool calls to answer complex questions:

```
User: "What percentage of my portfolio is in Ethereum, and how much is that in USD?"

The AI might:
1. Call dashboard_getOverview - Get total portfolio value
2. Call holdings_getWithDetails - Get all holdings
3. Filter for Ethereum holdings
4. Calculate percentage and USD value
```

### Data Filtering and Analysis

The AI can perform sophisticated analysis on the data returned by tools:

```
User: "Show me only my holdings that have lost value in the past month"

The AI will:
1. Call holdings_getWithDetails - Get all holdings with price history
2. Analyze price changes
3. Filter and present results
```

## Troubleshooting

### Connection Issues

**Problem**: MCP client can't connect to the server

**Solutions**:

1. Verify the URL is correct: `https://api.scani.finance/mcp`
2. Check your internet connection
3. Ensure your API key is correctly formatted in the Authorization header
4. Try accessing the API directly with `curl`:
   ```bash
   curl -H "Authorization: Bearer sk_live_YOUR_KEY" \
        https://api.scani.finance/mcp
   ```

### Authentication Failures

**Problem**: Getting 401 errors despite having an API key

**Solutions**:

1. Verify the key hasn't expired (check Settings > API Keys)
2. Ensure the key hasn't been revoked
3. Check that the Authorization header is properly formatted:
   - Correct: `Authorization: Bearer sk_live_...`
   - Incorrect: `Authorization: sk_live_...` (missing "Bearer")
4. Make sure there are no extra spaces or newlines in the key

### Tool Not Working

**Problem**: AI says a tool isn't available or isn't working

**Solutions**:

1. Check if the tool exists in the "Available Tools" section above
2. Ensure your MCP client has refreshed its tool list (restart if necessary)
3. Try calling the tool with minimal parameters first
4. Check the API logs for detailed error messages

## Technical Details

### Transport Protocol

The Scani MCP server uses the **Streamable HTTP transport** as defined in the MCP specification. This provides:

- **Stateless operation**: Each request is independent (no session management needed)
- **JSON response mode**: Simpler request/response without SSE streaming
- **Thread-safe authentication**: Uses AsyncLocalStorage for request-scoped auth context
- **Bun-compatible**: Uses WebStandardStreamableHTTPServerTransport

### Error Handling

All tool calls return structured responses:

**Success Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{ ... JSON result ... }"
    }
  ]
}
```

**Error Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"error\": \"Error message\", \"details\": \"Stack trace or validation errors\" }"
    }
  ]
}
```

## Support

For issues or questions:

- **Documentation**: [https://docs.scani.finance](https://docs.scani.finance)
- **GitHub Issues**: [https://github.com/yourusername/scani/issues](https://github.com/yourusername/scani/issues)
- **Email**: support@scani.finance

## Changelog

### Version 1.1.0 (2026-02-01)

- Implemented proper Streamable HTTP transport using MCP SDK
- Fixed thread-safety issues with AsyncLocalStorage for auth context
- Added comprehensive error handling to all tool callbacks
- Removed deprecated `inputSchema: {}` patterns
- Removed non-functional `tokens_getById` tool (pending implementation)

### Version 1.0.0 (2026-01-30)

- Initial MCP server release
- Support for users, dashboard, accounts, holdings, tokens, and institutions
- API key-based authentication
- HTTP transport support
