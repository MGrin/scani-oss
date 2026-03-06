# Scani MCP — Discovery & Registry Publishing

> Instructions for submitting Scani to MCP registries and directories.
> This content was moved from SKILL.md to keep the skill file focused on agent-consumable API documentation.

## Category and Tags

| Field | Value |
|-------|-------|
| **Category** | Finance & Fintech |
| **Subcategory** | Personal Finance / Portfolio Management |
| **Tags** | `finance`, `portfolio`, `crypto`, `stocks`, `holdings`, `wallet`, `x402`, `micropayments`, `personal-finance`, `defi`, `blockchain` |
| **Type** | ☁️ Cloud service (hosted HTTP MCP server) |
| **Language** | 📇 TypeScript |
| **Audience** | AI agents, trading bots, financial assistants |

## Listing Entry (for awesome-mcp-servers / similar)

```
Scani 📇 ☁️ – Personal finance management MCP server.
Track portfolios, holdings, and wallets across banks, brokerages, and crypto exchanges. Agents
self-register (no human sign-up required) and pay per-call with USDC on Base via the x402 protocol.
```

## Submit to Popular MCP Registries

### 1. Official MCP Registry (`registry.modelcontextprotocol.io`)

The official registry focuses on stdio-based npm packages today. For a remote HTTP server,
the recommended path is to submit via **DNS or HTTP ownership verification** of your API domain.

```bash
# Install the publisher CLI (macOS / Linux)
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

# macOS (Homebrew alternative)
# brew install mcp-publisher

# Windows: download the release archive from
# https://github.com/modelcontextprotocol/registry/releases/latest
# and extract mcp-publisher.exe to a directory in your PATH

# Authenticate with GitHub
mcp-publisher login github

# Publish using the server.json at the repo root
mcp-publisher publish
```

The `server.json` file is located at the root of the repository.
Namespace: `io.github.MGrin/scani`

Reference: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx

### 2. punkpeye/awesome-mcp-servers (glama.ai)

Open a PR to https://github.com/punkpeye/awesome-mcp-servers

Add the following line under the **Finance & Fintech** section (`💰`):

```
* Scani 📇 ☁️ - Personal finance management MCP server.
  Track portfolios, holdings, and wallets across banks, brokerages, and crypto exchanges.
  Agents self-register and pay per-call in USDC on Base via the x402 protocol.
```

### 3. Smithery (smithery.ai)

Submit via https://smithery.ai/submit (requires GitHub login).

Use these details:
- **Name**: Scani Finance MCP
- **Description**: Personal finance management for AI agents. Track portfolios, holdings, and wallets. Agents self-register without human interaction and use x402 micropayments (USDC on Base) for per-call billing.
- **Endpoint**: https://api.scani.xyz/mcp
- **Category**: Finance

### 4. Glama (glama.ai/mcp)

Submit via https://glama.ai/mcp/servers/submit or the Glama Discord: https://glama.ai/mcp/discord
