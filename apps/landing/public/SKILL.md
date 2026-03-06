# Scani MCP Skill

<!-- metadata
name: Scani Personal Finance MCP
category: Finance & Fintech
subcategory: Personal Finance / Portfolio Management
tags: finance, portfolio, crypto, stocks, holdings, wallet, x402, micropayments, personal-finance, defi, blockchain
audience: AI agents, trading bots, financial assistants
transport: streamable-http
protocol: json-rpc-2.0
auth: bearer
payment: x402 (USDC on Base)
endpoint: https://api.scani.xyz/mcp
skill_url: https://scani.xyz/SKILL.md
skill_url_alt: https://app.scani.xyz/SKILL.md
llm_txt: https://scani.xyz/llm.txt
license: MIT
-->

> A skill for autonomous AI agents (Claude, GPT, Cursor, etc.) to interact with
> the Scani Personal Finance API via the Model Context Protocol (MCP).

## Overview

Scani exposes a fully-featured personal finance MCP server that lets AI agents:

- Register themselves and get permanent API credentials (no human interaction needed)
- Track stock, crypto, and fiat holdings across banks, brokerages, and wallets
- Import blockchain wallet addresses for automatic on-chain balance tracking
- Read portfolio summaries and asset allocation breakdowns
- Pay per-call for premium features using USDC on Base via the **x402 protocol**

**Base URL:** `https://api.scani.xyz/mcp`  
**Protocol:** JSON-RPC 2.0 over HTTP POST  
**Auth:** `Authorization: Bearer <apiKey>`

---

## Quick Start (3 steps)

### Step 1 — Discover capabilities (no auth needed)

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "agent_getCapabilities",
      "arguments": {}
    }
  }' | jq '.result.content[0].text | fromjson'
```

### Step 2 — Register (no auth needed, one-time)

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "agent_register",
      "arguments": {
        "name": "MyAgent"
      }
    }
  }' | jq '.result.content[0].text | fromjson | .credentials'
```

**⚠️ Store the returned `apiKey` permanently — it is shown only once.**

### Step 3 — Use the API

```bash
export SCANI_KEY="sk_live_YOUR_KEY_HERE"

curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "agent_whoami",
      "arguments": {}
    }
  }' | jq '.result.content[0].text | fromjson'
```

---

## Authentication

All tools except `agent_register` and `agent_getCapabilities` require a Bearer token:

```
Authorization: Bearer sk_live_<your_api_key>
```

### MCP Client Authentication (initialize / tools/list)

The MCP `initialize` and `tools/list` methods also require a valid Bearer token. This means
standard MCP clients (Claude Desktop, Cursor, etc.) that begin their session with
`initialize` → `tools/list` need pre-configured credentials before they can discover tools.

The "no auth" registration flow (`agent_register` via `tools/call`) works for raw HTTP clients
but **not** for standard MCP client libraries that require `initialize` first.

**Recommended workflow for MCP clients:**

1. **Register via raw HTTP first** — call `agent_register` using `curl` or a script (see Quick Start)
2. **Store the returned API key** — persist it as an environment variable (e.g. `SCANI_API_KEY`)
3. **Configure the MCP client** — set the Bearer token in the MCP client's auth configuration
4. The client can now call `initialize` → `tools/list` → `tools/call` normally

> **Stateless server:** Scani's MCP endpoint does not use MCP sessions — no `Mcp-Session-Id` header is returned. Each request is independently authenticated via the Bearer token and is fully stateless.

---

## Pricing & x402 Payments

Scani uses the **x402 payment protocol** for per-call micropayments with USDC on Base.

> **x402 version note:** Scani implements x402 V1-style headers: `X-PAYMENT-REQUIRED` (402 response)
> and `X-PAYMENT-SIGNATURE` (payment submission). The x402 V2 standard (Dec 2025) uses non-prefixed
> `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers — Scani does **not** use those yet.

### Free Tier

The following are **always free** for every agent:
- Agent registration and identity tools
- Token/asset lookup and search
- Institution lookups
- User settings read/write
- `accounts_create` for up to **3 accounts**
- `holdings_create` for up to **10 holdings per account**
- Aggregate reads (`accounts_getAll`, `dashboard_getOverview`, etc.) while within limits

### Paid Tier

Once an agent exceeds free-tier limits:

| Tool | Cost (USDC) | When |
|------|-------------|------|
| `accounts_create` | $0.10 | After 3 accounts |
| `holdings_create` | $0.10 | After 10 holdings/account |
| `institutions_create` | $0.10 | After 3 accounts (same counter) |
| `accounts_getAll` | $0.04 | Over free-tier limits |
| `dashboard_getOverview` | $0.04 | Over free-tier limits |
| `holdings_getWithDetails` | $0.04 | Over free-tier limits |
| `wallet_importAddress` | $0.50 | Always |
| `screenshots_parse` | $0.15 | Always (AI compute cost) |
| `integrations_binance_validateKeys` | $0.10 | Always |
| `integrations_kraken_validateKeys` | $0.10 | Always |

### x402 Payment Flow

When a tool requires payment:

1. **Server returns HTTP 402** with the `X-PAYMENT-REQUIRED` header (base64-encoded JSON)
2. **Agent decodes** payment requirements to get: amount, recipient wallet, USDC address, network
3. **Agent signs** an EIP-3009 `transferWithAuthorization` using their USDC on Base
4. **Agent retries** the request with the `X-PAYMENT-SIGNATURE` header (base64-encoded signed payload)
5. **Server verifies and settles** via the x402 facilitator

#### Example: Handling a 402 response

```bash
# First call – triggers 402
RESPONSE=$(curl -si -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 10,
    "method": "tools/call",
    "params": {
      "name": "wallet_importAddress",
      "arguments": {
        "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "displayName": "Vitalik.eth"
      }
    }
  }')

HTTP_STATUS=$(echo "$RESPONSE" | head -1 | awk '{print $2}')

if [ "$HTTP_STATUS" = "402" ]; then
  # Extract payment requirements from header
  PAYMENT_HEADER=$(echo "$RESPONSE" | grep -i "x-payment-required:" | awk '{print $2}' | tr -d '\r')
  REQUIREMENTS=$(echo "$PAYMENT_HEADER" | base64 -d | jq .)
  
  echo "Payment required:"
  echo "$REQUIREMENTS" | jq '.accepts[0] | {amount: (.maxAmountRequired | tonumber / 1000000 | tostring + " USDC"), network, payTo}'
  
  # The agent must now:
  # 1. Hold USDC on Base at the configured network
  # 2. Sign an EIP-3009 transferWithAuthorization
  # 3. Base64-encode the signed payload
  # 4. Retry with X-PAYMENT-SIGNATURE header
fi
```

#### Signing a payment (TypeScript/viem example)

```typescript
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

// Get payment requirements from 402 response
const requirements = JSON.parse(
  Buffer.from(response.headers.get('X-PAYMENT-REQUIRED')!, 'base64').toString()
);
const { maxAmountRequired, payTo, asset: usdcAddress, network } = requirements.accepts[0];

// Sign EIP-3009 transferWithAuthorization
// EIP-3009 nonce is bytes32 (32 bytes = 64 hex chars)
const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
const validAfter = BigInt(0);
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

const signature = await walletClient.signTypedData({
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: usdcAddress,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: account.address,
    to: payTo,
    value: BigInt(maxAmountRequired),
    validAfter,
    validBefore,
    nonce: nonce,
  },
});

// Build x402 payment payload
const paymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network,
  payload: {
    signature,
    authorization: {
      from: account.address,
      to: payTo,
      value: maxAmountRequired,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: nonce,
    },
  },
};

// Retry with payment
const signedHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
const paidResponse = await fetch('https://api.scani.xyz/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${agentApiKey}`,
    'X-PAYMENT-SIGNATURE': signedHeader,
  },
  body: JSON.stringify(originalRequest),
});
```

#### Testnet (no real USDC needed)

Use Base Sepolia for testing. Set the `X402_NETWORK` on your own deployment to `eip155:84532`, or ask Scani support for a testnet endpoint.

Get testnet USDC from: https://faucet.circle.com/

---

## Tool Reference

### Agent Management

#### `agent_getCapabilities` — no auth required

Discover what the API can do.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_getCapabilities","arguments":{}}}'
```

#### `agent_register` — no auth required

Register a new agent and receive permanent API credentials.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "agent_register",
      "arguments": {
        "name": "MyTradingBot"
      }
    }
  }' | jq '.result.content[0].text | fromjson'
```

**Response:**
```json
{
  "success": true,
  "message": "Agent registered successfully!",
  "credentials": {
    "agentId": "uuid-here",
    "apiKey": "sk_live_...",
    "warning": "STORE THESE VALUES NOW - the apiKey will NEVER be shown again!"
  },
  "agent": { "name": "MyTradingBot", "createdAt": "..." },
  "usage": {
    "authentication": {
      "header": "Authorization",
      "value": "Bearer sk_live_..."
    },
    "nextSteps": [
      "Store agentId and apiKey in persistent storage",
      "Include Authorization header in all future MCP requests",
      "Call agent_whoami to verify your credentials work",
      "Call dashboard_getOverview to see your portfolio"
    ],
    "persistenceHint": "Store credentials in your agent memory/state system, environment variables, or secure file storage"
  }
}
```

<!-- Note: The live server currently returns "dashboard_getSummary" in nextSteps,
     which is a server-side bug (that tool does not exist). The correct value is
     "dashboard_getOverview" as documented above. -->

#### `agent_whoami` — auth required

Verify credentials and get agent info.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_whoami","arguments":{}}}'
```

---

### Dashboard

#### `dashboard_getOverview` — auth required

Get portfolio overview including total value, asset count, top holdings, and allocation.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dashboard_getOverview","arguments":{}}}'
```

#### `dashboard_getAssetAllocation` — auth required

Get allocation breakdown by dimension. The `dimension` parameter accepts exactly these values: `token`, `token_type`, `account`, `account_type`, `institution`, `institution_type`.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"dashboard_getAssetAllocation","arguments":{"dimension":"token"}}
  }'
```

---

### Institutions

#### `institutions_create` — auth required

Create a custom institution (bank, exchange, brokerage, etc.).

**Parameters:** `name` (string, required), `typeId` (uuid, required), `description` (string, optional), `website` (url, optional), `logoUrl` (uri, optional — logo image URL)

```bash
# 1. (Recommended) Fetch Open Graph metadata from the institution's website
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"institutions_getOpenGraphMetadata","arguments":{"url":"https://coinbase.com"}}
  }' | jq '.result.content[0].text | fromjson'
# → { "title": "Coinbase", "description": "...", "siteName": "Coinbase", "image": "..." }

# 2. Get institution types
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"institutionTypes_getAll","arguments":{}}}'

# 3. Create institution using the metadata
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"institutions_create","arguments":{
      "name":"Coinbase",
      "typeId":"<exchange-type-uuid>",
      "website":"https://coinbase.com",
      "description":"Leading crypto exchange"
    }}
  }'
```

#### `institutions_getByUserId` — auth required

List institutions that have at least one account belonging to the current user.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"institutions_getByUserId","arguments":{}}}'
```

#### `institutions_getAll` — auth required

Get all institutions (system catalogue).

#### `institutions_search` — auth required

Search institutions by name.

**Parameters:** `query` (string, required)

#### `institutions_getById` — auth required

Get a specific institution by ID.

**Parameters:** `id` (uuid, required)

#### `institutions_getOpenGraphMetadata` — auth required

Fetch Open Graph metadata from a URL (title, description, image).

**Parameters:** `url` (uri, required)

---

### Accounts

#### `accounts_getAll` — auth required

List all accounts.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"accounts_getAll","arguments":{}}}'
```

#### `accounts_create` — auth required

Create an account. Free for first 3 accounts; $0.10 USDC per account after that.

**Required:** `name`, `typeId`. **Optional:** `institutionId`, `description`.

> **Note:** `institutionId` is optional. You can create an account without linking it to an
> institution. This is useful for standalone cash/savings accounts.

```bash
# 1. Get account types
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"accountTypes_getAll","arguments":{}}}'

# 2. Create account (only name + typeId are required)
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "accounts_create",
      "arguments": {
        "name": "My Savings Account",
        "typeId": "<account-type-uuid>"
      }
    }
  }'
```

#### `accounts_getByUserIdWithSummary` — auth required

Get all accounts with summary information (totals, holding counts).

#### `accounts_getById` — auth required

Get a specific account by ID.

**Parameters:** `id` (uuid, required)

#### `accounts_getHoldings` — auth required

Get holdings for a specific account.

**Parameters:** `id` (uuid, required), `includeHidden` (boolean, optional)

#### `accounts_update` — auth required

Update an account.

**Parameters:** `id` (uuid, required), `name` (string, optional), `description` (string, optional), `isActive` (boolean, optional)

#### `accounts_delete` — auth required

Delete an account.

**Parameters:** `id` (uuid, required)

#### `accounts_bulkDelete` — auth required

Delete multiple accounts at once.

**Parameters:** `ids` (string[], required)

#### `accounts_bulkAssignGroups` — auth required

Assign groups to multiple accounts.

**Parameters:** `accountIds` (string[], required), `groupIds` (string[], required)

#### `accounts_getCommonGroups` — auth required

Get groups that are common across the specified accounts.

**Parameters:** `accountIds` (string[], required)

---

### Holdings

#### `holdings_getWithDetails` — auth required

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"holdings_getWithDetails","arguments":{}}}'
```

#### `holdings_create` — auth required

**Parameters:** `accountId` (uuid, required), `tokenId` (uuid, required), `balance` (string, required), `lastUpdated` (ISO 8601 datetime, optional — timestamp of last balance update)

```bash
# First find the token ID
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tokens_search","arguments":{"query":"BTC"}}}' \
  | jq '.result.content[0].text | fromjson | .tokens[0]'

# Create holding
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "holdings_create",
      "arguments": {
        "accountId": "<account-uuid>",
        "tokenId": "<token-uuid>",
        "balance": "0.5"
      }
    }
  }'
```

#### `holdings_update` — auth required

Update a holding's balance or visibility.

**Parameters:** `id` (string, required), `balance` (string, optional), `isHidden` (boolean, optional), `isActive` (boolean, optional)

#### `holdings_delete` — auth required

Delete a holding.

**Parameters:** `id` (string, required)

#### `holdings_bulkDelete` — auth required

Delete multiple holdings at once.

**Parameters:** `ids` (string[], required)

#### `holdings_restore` — auth required

Restore a previously hidden holding.

**Parameters:** `id` (string, required)

#### `holdings_updatePrice` — auth required

Force a price refresh for a holding.

**Parameters:** `id` (string, required)

#### `holdings_bulkAssignGroups` — auth required

Assign groups to multiple holdings.

**Parameters:** `holdingIds` (string[], required), `groupIds` (string[], required)

#### `holdings_getCommonGroups` — auth required

Get groups that are common across the specified holdings.

**Parameters:** `holdingIds` (string[], required)

---

### Blockchain Wallets

#### `wallet_importAddress` — auth required, **$0.50 USDC**

Import a blockchain wallet for automatic balance tracking.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -H "X-PAYMENT-SIGNATURE: <signed-payment-payload>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "wallet_importAddress",
      "arguments": {
        "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "displayName": "Vitalik.eth"
      }
    }
  }'
```

#### `wallet_getSupportedChains` — auth required

List all supported blockchain chains for wallet import.

#### `wallet_detectChains` — auth required

Detect which blockchain chains a wallet address belongs to.

**Parameters:** `address` (string, required)

---

### Groups

Groups are colour-coded labels that can be assigned to holdings and accounts for custom
portfolio segmentation (e.g. "Long-term", "DeFi", "Stablecoins").

#### `groups_create` — auth required

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"groups_create","arguments":{"name":"Long-term","color":"#3b82f6"}}
  }'
```

#### `groups_assignHoldingGroups` — auth required

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"groups_assignHoldingGroups","arguments":{
      "holdingId":"<holding-uuid>",
      "groupIds":["<group-uuid>"]
    }}
  }'
```

#### `groups_getAll` — auth required

List all user groups.

#### `groups_getAllWithCounts` — auth required

List all groups with holding and account counts.

#### `groups_update` — auth required

Update a group.

**Parameters:** `id` (uuid, required), `name` (string, optional, 1–50 chars), `color` (hex string, optional), `description` (string, optional, max 200 chars), `displayOrder` (number, optional), `isActive` (boolean, optional)

#### `groups_delete` — auth required

Delete a group.

**Parameters:** `id` (uuid, required)

#### `groups_assignAccountGroups` — auth required

Assign groups to an account.

**Parameters:** `accountId` (uuid, required), `groupIds` (uuid[], required — pass empty array to remove all)

---

### Screenshot Parsing

#### `screenshots_parse` — auth required, **$0.15 USDC**

Upload a portfolio screenshot and extract holdings using AI. Returns structured holdings ready
for `holdings_create`. Accepts PNG, JPG, JPEG, GIF or WebP images as base64-encoded strings.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `imageBase64` | string | ✅ | Base64-encoded image data |
| `filename` | string | ✅ | Original filename with extension |
| `context` | string | | Hint for the AI, e.g. "Binance spot wallet" |
| `minConfidence` | number (0–1) | | Minimum confidence threshold (default 0.5) |
| `accountId` | uuid | | Account ID to check for already-existing holdings |
| `accountType` | string | | Hint about account type, e.g. "crypto", "stock" |
| `expectedCurrency` | string | | Hint about primary currency, e.g. "USD" |
| `provider` | enum | | AI provider: `"openai"` (default), `"perplexity"`, `"deepseek"` |

```bash
# Encode your screenshot to base64
IMAGE_B64=$(base64 -w 0 /path/to/portfolio-screenshot.png)

# Parse it
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -H "X-PAYMENT-SIGNATURE: <signed-payment-payload>" \
  -d "{
    \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",
    \"params\":{\"name\":\"screenshots_parse\",\"arguments\":{
      \"imageBase64\":\"$IMAGE_B64\",
      \"filename\":\"portfolio-screenshot.png\",
      \"context\":\"Binance spot wallet\",
      \"minConfidence\":0.7
    }}
  }" | jq '.result.content[0].text | fromjson'
```

**Response shape:**
```json
{
  "holdings": [
    {
      "symbol": "BTC",
      "name": "Bitcoin",
      "balance": "0.5",
      "confidence": 0.95,
      "tokenId": "<uuid-if-found-in-db>",
      "holdingId": "<uuid-if-already-in-account>"
    }
  ],
  "overallConfidence": 0.92,
  "detectedCurrency": "USD",
  "summary": { "totalHoldings": 5, "holdingsWithTokenId": 4, "holdingsWithExistingBalance": 2 }
}
```

> **Workflow:** parse screenshot → use `tokenId` values from the response directly in
> `holdings_create`. For holdings without `tokenId`, call `tokens_search` first.

---

### Exchange Integrations

#### `integrations_binance_validateKeys` — auth required, **$0.10 USDC**

Connect a Binance account. Validates credentials and auto-imports all balances.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -H "X-PAYMENT-SIGNATURE: <signed-payment-payload>" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"integrations_binance_validateKeys","arguments":{
      "apiKey":"<binance-api-key>",
      "apiSecret":"<binance-api-secret>"
    }}
  }'
```

#### `integrations_kraken_validateKeys` — auth required, **$0.10 USDC**

Connect a Kraken account. Validates credentials and auto-imports all balances.

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -H "X-PAYMENT-SIGNATURE: <signed-payment-payload>" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"integrations_kraken_validateKeys","arguments":{
      "apiKey":"<kraken-api-key>",
      "apiSecret":"<kraken-api-secret>"
    }}
  }'
```

---

### Batch Operations

#### `batchOperations_createHoldingsWithDependencies` — auth required

Create multiple holdings with their institution/account dependencies in one call.

**Parameters:**
- `holdings` (array, required) — each item: `{ tokenId: uuid, balance: string }`
- `accountId` (uuid, optional) — when provided, adds holdings to an existing account instead of creating a new one

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "batchOperations_createHoldingsWithDependencies",
      "arguments": {
        "accountId": "<existing-account-uuid-optional>",
        "holdings": [
          { "tokenId": "<btc-uuid>", "balance": "0.5" },
          { "tokenId": "<eth-uuid>", "balance": "2.0" }
        ]
      }
    }
  }'
```

#### `batchOperations_updateHoldingsBatch` — auth required

Bulk update multiple holdings at once.

**Parameters:** `holdings` (array, required, min 1) — each item: `{ id: uuid, balance: string (numeric), lastUpdated?: datetime (optional) }`

---

### Tokens

#### `tokens_search` — auth required, **always free**

```bash
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SCANI_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tokens_search","arguments":{"query":"ethereum"}}}'
```

#### `tokens_getAll` — auth required, **always free**

Get all available tokens in the system.

---

### Reference Data

#### `accountTypes_getAll` — auth required

Get all available account types. No parameters.

#### `institutionTypes_getAll` — auth required

Get all available institution types. No parameters.

---

### User Settings

#### `users_getCurrent` — auth required

Get the current user's profile.

#### `users_updateCurrent` — auth required

Update the current user's profile.

**Parameters:** `name` (string, optional), `avatar` (url or null, optional), `baseCurrencyId` (uuid or null, optional)

#### `users_getSupportedCurrencies` — auth required

List all supported fiat currencies.

#### `users_getBaseCurrency` — auth required

Get the user's currently configured base currency.

---

## Identity Bridge (Human ↔ Agent)

An AI agent accumulates financial data under its own account. Users can claim that data to
consolidate it with their Scani account.

### Option 1 — Via MCP (`agent_linkToUser`)

Requires the **user's** Scani API key (generated in the web UI under Settings → API Keys).

```bash
# Authenticate as the HUMAN USER (not the agent)
curl -s -X POST https://api.scani.xyz/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "agent_linkToUser",
      "arguments": {
        "agentId": "<agent-uuid-from-registration>"
      }
    }
  }'
```

### Option 2 — Via Settings UI

1. Open Scani web app → Settings → **Linked AI Agents**
2. Click **Claim Agent**
3. Enter the agent's API key (the `sk_live_...` from registration)
4. Click **Claim Agent**

The agent's accounts and holdings will appear in your portfolio.

---

## Agent Lifecycle

```
1. agent_getCapabilities   → discover what's available (no auth)
2. agent_register          → get API key (no auth, one-time)
3. [store apiKey]          → persist credentials
4. agent_whoami            → verify credentials work
5. [use tools freely]      → within free tier
6. [pay via x402]          → when over free tier or using premium tools
7. agent_linkToUser        → optionally merge with human account
```

---

## Error Handling

All errors follow JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "Authentication required"
  },
  "id": 1
}
```

| Code | Meaning |
|------|---------|
| `-32001` | Authentication required or API key invalid |
| `-32402` | Payment required (x402) |
| `-32005` | Rate limit exceeded |
| `-32603` | Internal server error |

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success (or JSON-RPC error in body) |
| `401` | Missing or invalid authentication |
| `402` | Payment required (`X-PAYMENT-REQUIRED` header has details) |
| `429` | Rate limited (`Retry-After` header has seconds to wait) |
| `500` | Server error |

---

## Rate Limits

| Scope | Limit |
|-------|-------|
| Authenticated requests | 60/minute (burst: 90) |
| Agent registration | 5/hour per IP |

---

## Environment Setup for MCP Clients

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "scani": {
      "url": "https://api.scani.xyz/mcp",
      "headers": {
        "Authorization": "Bearer ${SCANI_API_KEY}"
      }
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "scani": {
      "url": "https://api.scani.xyz/mcp",
      "headers": {
        "Authorization": "Bearer ${SCANI_API_KEY}"
      }
    }
  }
}
```

### Persistent credential storage

The agent **must** store its `apiKey` and `agentId` persistently across sessions.
If credentials are lost, a new agent must be registered – previous data will be
inaccessible without claiming via the identity bridge.

Recommended storage:
- **Claude**: Project files or environment variables
- **Cursor**: Environment variables or workspace settings
- **Custom agent**: Encrypted key-value store or `.env` file

---

## Testing x402 Payments with Base Sepolia (no real money)

To test x402 payments without spending real USDC:

1. **Get testnet USDC** from the Circle faucet: https://faucet.circle.com/
2. **Configure your agent's wallet** on Base Sepolia (chain ID `84532`, CAIP-2: `eip155:84532`)
3. **Set `X402_NETWORK`** to `eip155:84532` on your own Scani deployment, or contact Scani support for a testnet endpoint
4. **Send payment requests** as normal — the flow is identical to mainnet, but uses testnet USDC
