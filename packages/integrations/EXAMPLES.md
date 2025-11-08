# Institution Integrations System - Examples

This document provides practical examples of how to implement integrations using the new `@scani/integrations` framework.

## Example 1: Manual Integration

The simplest integration type - for manually entered data:

```typescript
import { ScaniIntegration, IntegrationAuthType } from '@scani/integrations';
import type { FetchAccountsResult, FetchHoldingsResult, TokenMappingResult, IntegrationHolding } from '@scani/integrations';

class ManualIntegration extends ScaniIntegration {
  constructor(institutionId: string) {
    super(institutionId, {
      type: IntegrationAuthType.MANUAL,
    });
  }

  async fetchAccounts(): Promise<FetchAccountsResult> {
    // Manual integrations don't fetch accounts automatically
    return {
      accounts: [],
      total: 0,
    };
  }

  async fetchHoldings(accountId: string): Promise<FetchHoldingsResult> {
    // Manual integrations don't fetch holdings automatically
    return {
      holdings: [],
      total: 0,
      accountId,
      timestamp: new Date(),
    };
  }

  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    // For manual integrations, we trust the user's input
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: holding.tokenType || 'unknown',
        decimals: holding.decimals,
        iconUrl: holding.iconUrl,
      },
      isNew: false,
      confidence: 1.0,
    };
  }
}
```

## Example 2: RPC-based Blockchain Integration

For blockchain integrations using RPC connections:

```typescript
import { ScaniIntegration, IntegrationAuthType } from '@scani/integrations';
import type { FetchAccountsResult, FetchHoldingsResult, TokenMappingResult, IntegrationHolding } from '@scani/integrations';
import { ethers } from 'ethers';

class EthereumIntegration extends ScaniIntegration {
  private provider: ethers.JsonRpcProvider;

  constructor(institutionId: string, rpcUrl: string) {
    super(institutionId, {
      type: IntegrationAuthType.RPC,
      rpcUrl,
      chainId: 1, // Ethereum mainnet
    });
    
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    // For blockchain, the "account" is the wallet address
    const walletAddress = credentials?.walletAddress as string;
    
    if (!walletAddress) {
      throw new Error('Wallet address required');
    }

    // Verify the address is valid
    if (!ethers.isAddress(walletAddress)) {
      throw new Error('Invalid Ethereum address');
    }

    return {
      accounts: [{
        externalId: walletAddress,
        name: `Ethereum Wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
        accountType: 'wallet',
        metadata: {
          address: walletAddress,
          chainId: 1,
        },
      }],
      total: 1,
    };
  }

  async fetchHoldings(accountId: string): Promise<FetchHoldingsResult> {
    // Fetch ETH balance
    const balance = await this.executeWithRateLimit(() => 
      this.provider.getBalance(accountId)
    );

    const holdings: IntegrationHolding[] = [{
      symbol: 'ETH',
      name: 'Ethereum',
      balance: ethers.formatEther(balance),
      decimals: 18,
      tokenType: 'crypto',
      isNative: true,
      metadata: {
        address: accountId,
      },
    }];

    // TODO: Fetch ERC-20 token balances
    // This would involve querying the blockchain for token transfer events
    // or using a service like Etherscan API

    return {
      holdings,
      total: holdings.length,
      accountId,
      timestamp: new Date(),
    };
  }

  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    // Map Ethereum tokens to Scani format
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: 'crypto', // This should reference the crypto token type ID
        decimals: holding.decimals,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          contractAddress: holding.contractAddress,
          chainId: 1,
        }),
      },
      isNew: !holding.contractAddress, // New if it's a custom token
      confidence: holding.symbol === 'ETH' ? 1.0 : 0.8,
    };
  }
}
```

## Example 3: OAuth 2.0 Exchange Integration

For exchanges that use OAuth 2.0 authentication:

```typescript
import { ScaniIntegration, IntegrationAuthType } from '@scani/integrations';
import type { FetchAccountsResult, FetchHoldingsResult, TokenMappingResult, IntegrationHolding } from '@scani/integrations';

class BinanceIntegration extends ScaniIntegration {
  constructor(institutionId: string) {
    super(institutionId, {
      type: IntegrationAuthType.OAUTH,
      clientId: process.env.BINANCE_CLIENT_ID!,
      clientSecret: process.env.BINANCE_CLIENT_SECRET!,
      tokenEndpoint: 'https://api.binance.com/oauth/token',
      authorizationEndpoint: 'https://www.binance.com/oauth/authorize',
      scopes: ['read:account', 'read:balances'],
    });
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    const accessToken = credentials?.accessToken as string;
    
    if (!accessToken) {
      throw new Error('Access token required');
    }

    // Fetch account info from Binance API
    const response = await this.executeWithRateLimit(() =>
      fetch('https://api.binance.com/api/v3/account', {
        headers: {
          'X-MBX-APIKEY': accessToken,
        },
      })
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch accounts: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      accounts: [{
        externalId: data.accountType,
        name: `Binance ${data.accountType}`,
        accountType: 'exchange',
        metadata: {
          canTrade: data.canTrade,
          canWithdraw: data.canWithdraw,
          canDeposit: data.canDeposit,
        },
      }],
      total: 1,
    };
  }

  async fetchHoldings(accountId: string, credentials?: Record<string, unknown>): Promise<FetchHoldingsResult> {
    const accessToken = credentials?.accessToken as string;
    
    if (!accessToken) {
      throw new Error('Access token required');
    }

    // Fetch balances from Binance API
    const response = await this.executeWithRateLimit(() =>
      fetch('https://api.binance.com/api/v3/account', {
        headers: {
          'X-MBX-APIKEY': accessToken,
        },
      })
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch holdings: ${response.statusText}`);
    }

    const data = await response.json();

    const holdings: IntegrationHolding[] = data.balances
      .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b: any) => ({
        symbol: b.asset,
        name: b.asset, // Binance doesn't provide full names in balances endpoint
        balance: (parseFloat(b.free) + parseFloat(b.locked)).toString(),
        decimals: 8, // Default for most crypto
        tokenType: 'crypto',
        externalTokenId: b.asset,
        metadata: {
          free: b.free,
          locked: b.locked,
        },
      }));

    return {
      holdings,
      total: holdings.length,
      accountId,
      timestamp: new Date(),
    };
  }

  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    // Map Binance token symbols to Scani format
    // This might involve looking up the token in a database or using a mapping service
    
    const normalizedSymbol = holding.symbol === 'WBTC' ? 'BTC' : holding.symbol;

    return {
      token: {
        symbol: normalizedSymbol,
        name: holding.name,
        typeId: 'crypto',
        decimals: holding.decimals,
        providerMetadata: JSON.stringify({
          binanceAsset: holding.symbol,
          externalTokenId: holding.externalTokenId,
        }),
      },
      isNew: false,
      confidence: 0.9,
    };
  }

  async refreshAuthentication(refreshToken: string): Promise<Record<string, unknown>> {
    // Implement OAuth token refresh
    const response = await fetch(this.authConfig.type === 'oauth' ? this.authConfig.tokenEndpoint : '', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.authConfig.type === 'oauth' ? this.authConfig.clientId : '',
        client_secret: this.authConfig.type === 'oauth' ? this.authConfig.clientSecret : '',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh authentication');
    }

    return response.json();
  }
}
```

## Example 4: API Key Integration

For traditional APIs that use API keys:

```typescript
import { ScaniIntegration, IntegrationAuthType } from '@scani/integrations';
import type { FetchAccountsResult, FetchHoldingsResult, TokenMappingResult, IntegrationHolding } from '@scani/integrations';

class TraditionalBrokerIntegration extends ScaniIntegration {
  constructor(institutionId: string, apiKey: string, baseUrl: string) {
    super(institutionId, {
      type: IntegrationAuthType.API_KEY,
      apiKey,
      baseUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async fetchAccounts(): Promise<FetchAccountsResult> {
    const config = this.authConfig;
    if (config.type !== 'api_key') {
      throw new Error('Invalid auth config');
    }

    const response = await this.executeWithRateLimit(() =>
      fetch(`${config.baseUrl}/accounts`, {
        headers: config.headers,
      })
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch accounts: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      accounts: data.accounts.map((acc: any) => ({
        externalId: acc.id,
        name: acc.name,
        accountType: acc.type,
        description: acc.description,
        metadata: acc,
      })),
      total: data.accounts.length,
    };
  }

  async fetchHoldings(accountId: string): Promise<FetchHoldingsResult> {
    const config = this.authConfig;
    if (config.type !== 'api_key') {
      throw new Error('Invalid auth config');
    }

    const response = await this.executeWithRateLimit(() =>
      fetch(`${config.baseUrl}/accounts/${accountId}/holdings`, {
        headers: config.headers,
      })
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch holdings: ${response.statusText}`);
    }

    const data = await response.json();

    const holdings: IntegrationHolding[] = data.holdings.map((h: any) => ({
      symbol: h.symbol,
      name: h.name,
      balance: h.quantity.toString(),
      decimals: h.decimals || 2,
      tokenType: h.type || 'stock',
      externalTokenId: h.id,
      metadata: h,
    }));

    return {
      holdings,
      total: holdings.length,
      accountId,
      timestamp: new Date(),
    };
  }

  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: holding.tokenType || 'stock',
        decimals: holding.decimals,
        providerMetadata: JSON.stringify(holding.metadata),
      },
      isNew: false,
      confidence: 1.0,
    };
  }
}
```

## Usage in Backend

Here's how you would use these integrations in your backend code:

```typescript
// 1. Create an integration instance
const integration = new BinanceIntegration('binance-institution-id');

// 2. Check if credentials are valid
const isValid = await integration.validateCredentials({
  accessToken: userAccessToken,
});

if (!isValid) {
  throw new Error('Invalid credentials');
}

// 3. Fetch accounts
const accountsResult = await integration.fetchAccounts({
  accessToken: userAccessToken,
});

// 4. For each account, fetch holdings
for (const account of accountsResult.accounts) {
  const holdingsResult = await integration.fetchHoldings(
    account.externalId,
    { accessToken: userAccessToken }
  );

  // 5. Map each holding to Scani token format
  for (const holding of holdingsResult.holdings) {
    const mappingResult = await integration.mapToken(holding);
    
    // 6. Save to database
    // Use mappingResult.token to create/update tokens in Scani
    // Use holding.balance to create/update holdings
  }
}

// 7. Check integration health
const status = await integration.checkHealth();
console.log('Integration status:', status);
```

## Future Migration Path

When migrating blockchain sync from `@scani/core` to this new system:

1. Create blockchain-specific integration classes (EthereumIntegration, BitcoinIntegration, etc.)
2. Move the existing blockchain service logic into these integration classes
3. Update the sync jobs to use the integration classes instead of direct service calls
4. Keep the `IBlockchainService` interface in core for backward compatibility initially
5. Gradually phase out the old blockchain services

This allows for a smooth migration while maintaining existing functionality.
