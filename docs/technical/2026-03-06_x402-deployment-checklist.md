# x402 + MCP Agent Integration – Deployment Checklist

_Last updated: 2026-03-06_

This document describes the **current state of the PR** and the **complete action list** needed
before and during deployment of the x402 paywall + agent self-registration feature.

---

## Current State of the PR

### ✅ Fully implemented and working

| Component | Location | Status |
|-----------|----------|--------|
| x402 payment middleware | `apps/backend/src/infrastructure/mcp/x402-middleware.ts` | ✅ |
| Spec-compliant 402 responses (`X-PAYMENT-REQUIRED` header, CAIP-2 IDs) | same | ✅ |
| Facilitator-based payment verification and settlement | same | ✅ |
| x402 wired into `handleMcpRequest` (after auth, before tool execution) | `apps/backend/src/infrastructure/mcp/server.ts` | ✅ |
| Agent self-registration (`agent_register` MCP tool, rate-limited) | `apps/backend/src/infrastructure/mcp/tools/agent.ts` | ✅ |
| Agent whoami, capabilities, link-to-user tools | same | ✅ |
| `agents.claimAgentIdentity` tRPC endpoint | `apps/backend/src/presentation/routers/agents.ts` | ✅ |
| `agents.listLinkedAgents` tRPC endpoint | same | ✅ |
| Agents router wired into main tRPC router | `apps/backend/src/presentation/router.ts` | ✅ |
| **Linked AI Agents** section in Settings UI | `apps/frontendV2/src/components/settings/LinkedAgentsSection.tsx` | ✅ |
| `AgenticUserService.getLinkedAgents()` | `packages/core/src/services/AgenticUserService.ts` | ✅ |
| `users.linked_to_user_id` DB column | migration `0031_groovy_starjammers.sql` | ✅ |
| 41 unit tests for x402 logic | `apps/backend/src/infrastructure/mcp/x402-middleware.test.ts` | ✅ |
| End-to-end integration test script | `scripts/test-mcp-integration.ts` | ✅ |
| MCP skill document for AI agents | `docs/technical/2026-03-06_mcp-skill.md` | ✅ |
| x402 env vars in `.env.example` | `apps/backend/.env.example` | ✅ |

### 🔮 Planned / not yet implemented

The PAID_TOOLS pricing table is ready for these tools but they are not yet registered as MCP tools:

| Tool | Type | Price | Notes |
|------|------|-------|-------|
| `accounts_create` | creation | free / $0.10 | MCP tool not yet registered |
| `holdings_create` | creation | free / $0.10 | MCP tool not yet registered |
| `screenshot_parse` | fixed | $0.15 | MCP tool not yet registered |
| `binance_integrate` | fixed | $0.10 | MCP tool not yet registered |
| `kraken_integrate` | fixed | $0.10 | MCP tool not yet registered |

When any of these tools are added to the MCP server, remove the `// FUTURE:` comment from the
corresponding entry in `PAID_TOOLS` in `x402-middleware.ts`.

### Currently live paid tools

| Tool | Type | Price |
|------|------|-------|
| `wallet_importAddress` | fixed | $0.50 |
| `dashboard_getOverview` | reading (over limit) | $0.04 |
| `dashboard_getAssetAllocation` | reading (over limit) | $0.04 |
| `accounts_getAll` | reading (over limit) | $0.04 |
| `accounts_getByUserIdWithSummary` | reading (over limit) | $0.04 |
| `holdings_getWithDetails` | reading (over limit) | $0.04 |
| `holdings_getCommonGroups` | reading (over limit) | $0.04 |

---

## Pre-Deployment Actions

### 1. Set up a receiving wallet (REQUIRED)

You need a Base-compatible wallet to receive USDC payments from agents.

**Option A – Coinbase account (simplest)**
1. Create or log in at https://www.coinbase.com
2. Go to **Assets → USDC → Base network**
3. Copy your Base wallet address (starts with `0x`)

**Option B – Hardware wallet (most secure)**
1. Use Ledger or Trezor with Base network configured
2. Copy the Base address

**Option C – Generate a dedicated server wallet**
```bash
# Using cast (from foundry)
cast wallet new
# OR using ethers in Node/Bun
node -e "const { ethers } = require('ethers'); const w = ethers.Wallet.createRandom(); console.log('Address:', w.address); console.log('Private key:', w.privateKey)"
```

⚠️ If using Option C, back up the private key securely. The wallet only *receives* funds –
you never need the private key on the server.

### 2. Set up the x402 facilitator

**Testnet (no setup needed)**
- Default facilitator: `https://x402.org/facilitator`
- Uses Base Sepolia
- No API keys required
- Get free test USDC: https://faucet.circle.com

**Production (recommended for mainnet)**

You can use the x402.org mainnet facilitator or the CDP facilitator:

**x402.org mainnet facilitator:**
- URL: `https://x402.org/facilitator`
- No API key required currently
- Supports Base mainnet (`eip155:8453`)

**Coinbase CDP facilitator (if you want CDP):**
1. Create a Coinbase Developer Platform account: https://portal.cdp.coinbase.com
2. Create a new project
3. Generate an API key under **API Keys**
4. Note the API key name and private key
5. The CDP facilitator URL: `https://api.cdp.coinbase.com/platform/v2/x402`
6. CDP requires Bearer auth – see note below

> **Note on CDP auth**: The current middleware implementation does not pass CDP credentials
> to the facilitator (it uses the x402.org facilitator which needs no auth by default).
> If you want to use CDP, you will need to add `Authorization: Bearer <cdp_api_key>` to
> the facilitator fetch calls in `verifyWithFacilitator` and `settleWithFacilitator`.
> For now, `https://x402.org/facilitator` works for both testnet and mainnet.

### 3. Configure environment variables

Add these to your Render environment variables (or `.env` for local):

```bash
# REQUIRED – your receiving wallet address (Step 1)
SCANI_WALLET_ADDRESS=0xYourWalletAddressHere

# REQUIRED – public URL of your backend API (used in x402 payment requirements)
# Must match the URL agents use to reach the MCP endpoint
# If your custom domain is api.scani.xyz, use that. If using Render directly:
BACKEND_URL=https://api.scani.xyz

# OPTIONAL – defaults to x402.org if not set
# For mainnet production (recommended):
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_NETWORK=eip155:8453

# For testnet:
# X402_FACILITATOR_URL=https://x402.org/facilitator
# X402_NETWORK=eip155:84532
```

> **Domain note**: `BACKEND_URL` defaults to `https://api.scani.xyz` in the middleware code.
> Set this variable explicitly if deploying to a different domain (e.g. `https://scani-backend-217c.onrender.com`).
> The SKILL.md and server.json already reference `api.scani.xyz`.

### 4. Database migration check

The required DB column (`linked_to_user_id` on `users` table) was added in migration
`0031_groovy_starjammers.sql`. Verify it is applied:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'linked_to_user_id';
```

If the column is missing, run:
```bash
bun run db:migrate
```

### 5. Run unit tests

```bash
bun test apps/backend/src/infrastructure/mcp/x402-middleware.test.ts
# Expected: 41 pass, 0 fail
```

### 6. Test on Base Sepolia (testnet dry-run)

Before going live, run the integration test script against your staging server:

```bash
# Get test USDC from https://faucet.circle.com (Base Sepolia)
# Set X402_NETWORK=eip155:84532 on the server

MCP_URL=https://your-staging-server.onrender.com/mcp \
SKIP_PAID_TESTS=true \
  bun scripts/test-mcp-integration.ts
```

This tests:
- Agent registration
- Free-tier tool calls
- 402 response format
- Claim identity flow

---

## During Deployment (Render)

### Step-by-step deployment on Render

1. **Go to Render dashboard** → select your backend service

2. **Add environment variables**:
   ```
   SCANI_WALLET_ADDRESS = 0xYourWalletAddressHere
   X402_NETWORK         = eip155:8453
   X402_FACILITATOR_URL = https://x402.org/facilitator
   ```

3. **Deploy** – Render auto-deploys on push to the tracked branch, or click **Manual Deploy**

4. **Verify deployment**:
   ```bash
   # Test the MCP endpoint is alive
   curl -s https://your-backend.onrender.com/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_getCapabilities","arguments":{}}}' \
     | jq '.result.content[0].text | fromjson | .name'
   # Expected: "Scani Finance MCP"
   ```

5. **Test a 402 response**:
   ```bash
   # First register an agent
   API_KEY=$(curl -s https://your-backend.onrender.com/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_register","arguments":{"name":"DeployTest"}}}' \
     | jq -r '.result.content[0].text | fromjson | .credentials.apiKey')
   
   # Try to import a wallet (should get 402)
   HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
     -X POST https://your-backend.onrender.com/mcp \
     -H "Content-Type: application/json" \
     -H "Authorization: ******" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wallet_importAddress","arguments":{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"ethereum"}}}')
   
   echo "Status: $HTTP_STATUS"  # Expected: 402
   ```

6. **Run the integration test suite** against production (with `SKIP_PAID_TESTS=true` for the first run):
   ```bash
   MCP_URL=https://your-backend.onrender.com/mcp \
   SKIP_PAID_TESTS=true \
     bun scripts/test-mcp-integration.ts
   ```

---

## Post-Deployment

### Monitor for issues

Watch these in your Render logs (or Sentry):

- `x402 payment required` – normal, means agents are hitting paid endpoints
- `x402 payment verified and settlement initiated` – payment flow working
- `x402 payment settlement failed` – ⚠️ payment verified but not settled (investigate)
- `x402 payment verification failed via facilitator` – bad payment proof (agent bug or attack)

### Verify payments are arriving

Check your receiving wallet on Basescan:
```
https://basescan.org/address/0xYourWalletAddressHere
```

Look for USDC token transfers.

### Rotate API keys if compromised

If you need to rotate `SCANI_WALLET_ADDRESS`, existing payment proofs targeting the old address
will fail verification. Update the env var and redeploy.

---

## Known limitations / Future work

1. **`accounts_create` and `holdings_create` MCP tools are not yet registered** – these are
   listed in `agent_getCapabilities` as available tools, but no `server.registerTool()` calls
   exist for them yet. Adding them is required for full CRUD agent workflows.

2. **`screenshot_parse`, `binance_integrate`, `kraken_integrate` tools are not yet registered** –
   pricing is configured, tools need to be implemented.

3. **CDP facilitator auth** – if you switch to the CDP facilitator
   (`https://api.cdp.coinbase.com/platform/v2/x402`), you need to add Bearer auth headers to
   the facilitator fetch calls in `x402-middleware.ts`.

4. **Payment receipt storage** – currently, successful payments are verified and settled but
   not stored in the database. For auditing or replay protection, consider storing payment
   nonces in a `x402_payments` table.

5. **Test coverage of reading-over-limit** – the integration test script can't test
   reading-over-limit behavior (would need to create >3 accounts first). Manual testing
   of this flow is recommended once `accounts_create` MCP tool is implemented.

---

## Registering as a Discoverable MCP Skill

Once deployed, list Scani in the major MCP server registries so agents can discover it.

### Registry submission checklist

- [ ] **Official MCP Registry** (`registry.modelcontextprotocol.io`)
  1. Install `mcp-publisher` CLI (see SKILL.md → Discovery & Registries section)
  2. Run `mcp-publisher login github` (uses your GitHub @MGrin account)
  3. Update the `server.json` at the repo root with the correct version and endpoint URL
  4. Run `mcp-publisher publish` from the repo root

- [ ] **punkpeye/awesome-mcp-servers**
  1. Fork https://github.com/punkpeye/awesome-mcp-servers
  2. Add to the **Finance & Fintech** section:
     ```
     * [MGrin/scani](https://github.com/MGrin/scani) 📇 ☁️ - Personal finance management MCP server.
       Track portfolios, holdings, and wallets across banks, brokerages, and crypto exchanges.
       Agents self-register and pay per-call in USDC on Base via the x402 protocol.
     ```
  3. Open a PR

- [ ] **Smithery** — submit at https://smithery.ai/submit
  - Category: Finance
  - Endpoint: `https://api.scani.xyz/mcp`

- [ ] **Glama** — submit via https://glama.ai/mcp/discord or the Glama MCP community form

### Verify SKILL.md is accessible

The SKILL.md is served by the frontend static site at `https://app.scani.xyz/SKILL.md` (or your frontend URL). Verify it is reachable before registering:

```bash
curl -I https://app.scani.xyz/SKILL.md
# Expected: HTTP/2 200
```
