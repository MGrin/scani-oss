# Cron Jobs

This document describes the scheduled cron jobs running in the Scani backend.

## Overview

The backend uses [@elysiajs/cron](https://elysiajs.com/plugins/cron.html) to schedule periodic tasks. All cron jobs are configured in `apps/backend/src/index.ts` and execute use cases from the application layer.

## Active Cron Jobs

### 1. Pricing Cron Job

**Purpose**: Updates token prices for all tokens that have active holdings.

**Schedule**: Every 30 minutes (at :00 and :30)  
**Cron Pattern**: `0,30 * * * *`

**Implementation**: 
- Use Case: `UpdateTokenPricesUseCase`
- Cron Job: `apps/backend/src/infrastructure/cron/PricingCronJob.ts`

**How it works**:
1. Queries the database for all unique tokens that have at least one holding
2. Fetches fresh prices from pricing providers (Finnhub, CoinGecko, DeFiLlama)
3. Respects rate limits of external APIs
4. Caches prices in the database for future queries
5. Logs comprehensive metrics about the update

**Key Features**:
- Only updates prices for tokens that are actively held by users
- Batches price requests to minimize API calls
- Handles rate limiting gracefully
- Falls back to last known good price if providers fail

### 2. Exchange Balances Sync Cron Job

**Purpose**: Synchronizes exchange account balances for all accounts imported via exchange integrations (Binance, Kraken, etc.).

**Schedule**: Every 15 minutes  
**Cron Pattern**: `*/15 * * * *`

**Implementation**:
- Use Case: `SyncExchangeBalancesUseCase`
- Cron Job: `apps/backend/src/infrastructure/cron/ExchangeBalancesCronJob.ts`

**How it works**:
1. Finds all accounts with exchange credentials (Binance, Kraken)
2. For each exchange account, fetches current balances from the exchange API
3. Updates existing holdings with new balances (preserving hidden state)
4. Creates new holdings when account owns new tokens
5. Updates holdings when balance goes to 0 (keeping them for future syncs)
6. Updates account metadata with last sync timestamp
7. Respects rate limits of exchange APIs

**Key Features**:
- Supports multiple exchanges (Binance, Kraken)
- Automatically discovers new tokens in exchange accounts
- Preserves hidden holdings state while updating balances
- Respects exchange API rate limits
- Non-blocking operation - individual account failures don't stop the entire sync

### 3. Wallet Balances Sync Cron Job

**Purpose**: Synchronizes blockchain wallet balances for all accounts imported via blockchain services.

**Schedule**: Every 15 minutes  
**Cron Pattern**: `*/15 * * * *`

**Implementation**:
- Use Case: `SyncWalletBalancesUseCase`
- Cron Job: `apps/backend/src/infrastructure/cron/WalletBalancesCronJob.ts`

**How it works**:
1. Finds all accounts with wallet addresses in metadata
2. For each wallet, fetches current balances from blockchain APIs
3. Updates existing holdings with new balances
4. Creates new holdings when wallet owns new tokens
5. Removes holdings when balance goes to 0
6. Updates account metadata with last sync timestamp
7. Fetches prices for any new tokens discovered

**Key Features**:
- Supports multiple blockchains (Ethereum, Bitcoin, Solana, Tron, TON, and EVM-compatible chains)
- Automatically discovers new tokens in wallets
- Removes holdings for tokens that are no longer owned
- Respects blockchain API rate limits
- Non-blocking price fetching for discovered tokens

## Architecture

### Use Cases Layer

All cron jobs delegate to use cases in the application layer:
- `@scani/core/use-cases/UpdateTokenPricesUseCase.ts` - Price updates
- `@scani/core/use-cases/SyncExchangeBalancesUseCase.ts` - Exchange balance sync
- `@scani/core/use-cases/SyncWalletBalancesUseCase.ts` - Wallet balance sync

This follows the clean architecture pattern, keeping business logic separate from infrastructure concerns.

### Service Dependencies

The use cases leverage existing services:
- `PricingService` - Fetches prices from external APIs
- `IntegrationManager` - Manages exchange integrations (Binance, Kraken)
- `BlockchainServiceManager` - Fetches wallet balances from blockchain APIs
- `TokenRepository` - Database access for tokens
- `HoldingRepository` - Database access for holdings
- `IntegrationCredentialsService` - Manages encrypted credentials for exchanges

## Monitoring and Logging

All cron jobs include comprehensive logging:

**Pricing Cron Job logs**:
- Start/end of execution
- Number of tokens processed
- Success/failure counts
- Execution duration
- Individual token errors

**Exchange Balances Cron Job logs**:
- Start/end of execution
- Number of accounts found/synced/failed
- Holdings updated/created/removed
- Execution duration
- Individual account errors
- Institution-specific errors

**Wallet Balances Cron Job logs**:
- Start/end of execution
- Number of accounts processed
- Holdings updated/created/removed
- Execution duration
- Individual wallet errors

**Log Component**: All jobs use component loggers with identifiers:
- `cron:pricing` - Pricing cron job
- `cron:exchange-balances` - Exchange balances cron job
- `cron:wallet-balances` - Wallet balances cron job

## Configuration

Cron jobs are configured in `apps/backend/src/index.ts`:

```typescript
import { cron } from '@elysiajs/cron';
import {
  executePricingCronJob,
  executeExchangeBalancesCronJob,
  executeWalletBalancesCronJob,
} from './infrastructure/cron';

const app = new Elysia()
  .use(
    cron({
      name: 'pricing-cron',
      pattern: '0,30 * * * *', // Every 30 minutes at :00 and :30
      run: executePricingCronJob,
    })
  )
  .use(
    cron({
      name: 'exchange-balances-cron',
      pattern: '*/15 * * * *', // Every 15 minutes
      run: executeExchangeBalancesCronJob,
    })
  )
  .use(
    cron({
      name: 'wallet-balances-cron',
      pattern: '*/15 * * * *', // Every 15 minutes
      run: executeWalletBalancesCronJob,
    })
  )
```

## Error Handling

All cron jobs implement robust error handling:

1. **Non-blocking errors**: Individual token/wallet/account failures don't stop the entire job
2. **Error logging**: All errors are logged with context for debugging
3. **Graceful degradation**: Jobs continue on next schedule even if current execution fails
4. **No crashes**: Exceptions are caught and logged, preventing server crashes
5. **Rate limit handling**: Exchange and blockchain API rate limits are respected to avoid temporary bans

## Testing

To test cron jobs manually:

1. Start the backend server:
   ```bash
   cd apps/backend
   bun dev
   ```

2. Monitor logs for cron job execution:
   - Pricing cron runs at :00 and :30 minutes
   - Exchange balances cron runs every 15 minutes
   - Wallet balances cron runs every 15 minutes

3. Check logs for execution results and any errors

4. Test exchange sync by:
   - Adding Binance or Kraken API credentials through the frontend
   - Wait for the next 15-minute cycle or restart the backend
   - Check logs for `cron:exchange-balances` output

## Future Improvements

Potential enhancements:
- Add configuration for cron schedules via environment variables
- Add metrics/monitoring dashboard for cron job execution
- Add manual trigger endpoints for admin users
- Add cron job health checks and alerting
- Add distributed locking for running in multi-instance deployments
