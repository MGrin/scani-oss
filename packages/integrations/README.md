# @scani/integrations

Institution integration framework for Scani Finance SaaS platform.

## Overview

This package provides the foundation for integrating Scani with various financial institutions. It defines an abstract base class `ScaniIntegration` that all concrete integrations must implement.

## Features

- **Multiple Authentication Types**: Supports OAuth 2.0, RPC, API keys, and manual entry
- **Abstract Interface**: Clean separation between integration logic and implementation
- **Rate Limiting**: Built-in support for rate-limited API calls
- **Type Safety**: Full TypeScript support with comprehensive type definitions

## Supported Integration Types

### OAuth 2.0
For integrations with modern APIs that use OAuth 2.0 authentication:
- Cryptocurrency exchanges (Binance, Coinbase, Kraken)
- Modern broker APIs

### RPC (Remote Procedure Call)
For blockchain network integrations:
- Ethereum and EVM-compatible chains
- Bitcoin
- Solana
- TON
- Other blockchain networks

### API Key
For traditional API integrations:
- Legacy broker APIs
- Financial data providers

### Manual
For manual data entry (no automatic synchronization).

## Architecture

```
ScaniIntegration (abstract base class)
├── fetchAccounts()      - Retrieve all accounts from institution
├── fetchHoldings()      - Retrieve holdings for a specific account
├── mapToken()           - Map institution token to Scani format
├── checkHealth()        - Optional health check
├── validateCredentials() - Optional credential validation
└── refreshAuthentication() - Optional token refresh (OAuth)
```

## Usage Example

```typescript
import { ScaniIntegration, IntegrationAuthType, type FetchAccountsResult } from '@scani/integrations';

class MyExchangeIntegration extends ScaniIntegration {
  constructor(institutionId: string) {
    super(institutionId, {
      type: IntegrationAuthType.OAUTH,
      clientId: process.env.EXCHANGE_CLIENT_ID!,
      clientSecret: process.env.EXCHANGE_CLIENT_SECRET!,
      tokenEndpoint: 'https://api.exchange.com/oauth/token',
      authorizationEndpoint: 'https://api.exchange.com/oauth/authorize',
      scopes: ['read:accounts', 'read:balances'],
    });
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    // Fetch accounts from the exchange API
    const response = await this.executeWithRateLimit(() => 
      fetch('https://api.exchange.com/v1/accounts', {
        headers: {
          Authorization: `Bearer ${credentials?.accessToken}`,
        },
      })
    );
    
    const data = await response.json();
    
    return {
      accounts: data.accounts.map(acc => ({
        externalId: acc.id,
        name: acc.name,
        accountType: acc.type,
        metadata: { raw: acc },
      })),
      total: data.accounts.length,
    };
  }

  async fetchHoldings(accountId: string, credentials?: Record<string, unknown>) {
    // Implementation
  }

  async mapToken(holding) {
    // Implementation
  }
}
```

## Integration Development Guide

### 1. Create a New Integration Class

Extend `ScaniIntegration` and implement the required methods:

```typescript
class MyIntegration extends ScaniIntegration {
  // Constructor with auth config
  constructor(institutionId: string, config: MyConfig) {
    super(institutionId, {
      type: IntegrationAuthType.API_KEY,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
  }

  // Required: Fetch accounts
  async fetchAccounts(credentials) {
    // Your implementation
  }

  // Required: Fetch holdings for an account
  async fetchHoldings(accountId, credentials) {
    // Your implementation
  }

  // Required: Map institution tokens to Scani format
  async mapToken(holding) {
    // Your implementation
  }

  // Optional: Health check
  async checkHealth() {
    // Your implementation
  }
}
```

### 2. Handle Different Authentication Types

The base class provides `authConfig` that can be one of four types:

```typescript
// OAuth example
{
  type: IntegrationAuthType.OAUTH,
  clientId: string,
  clientSecret: string,
  // ... other OAuth fields
}

// RPC example
{
  type: IntegrationAuthType.RPC,
  rpcUrl: string,
  chainId: string | number,
}

// API Key example
{
  type: IntegrationAuthType.API_KEY,
  apiKey: string,
  baseUrl: string,
}
```

### 3. Use Rate Limiting

The base class provides `executeWithRateLimit` for API calls:

```typescript
async fetchAccounts(credentials) {
  return this.executeWithRateLimit(async () => {
    // Your API call here
    const response = await fetch(url);
    return response.json();
  });
}
```

## Future Work

This package is designed to support future integrations including:

1. **Blockchain Migration**: Move existing blockchain synchronization logic from `@scani/core` to integration implementations
2. **Exchange Integrations**: Binance, Coinbase, Kraken OAuth integrations
3. **Broker Integrations**: Traditional broker API integrations
4. **Bank Integrations**: Open banking APIs (PSD2, Plaid, etc.)

## Type Definitions

All types are fully documented in `src/types.ts`. Key types include:

- `AuthConfig` - Authentication configuration union type
- `IntegrationAccount` - Account representation from institution
- `IntegrationHolding` - Holding/balance representation
- `TokenMappingResult` - Result of token mapping operation
- `IntegrationStatus` - Integration health status

## Dependencies

- `@scani/shared` - Shared types and utilities
- `decimal.js` - Precise decimal arithmetic
- `zod` - Runtime type validation

## License

Private - Part of Scani Finance SaaS platform
