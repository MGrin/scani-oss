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

### 2. Wallet Balances Sync Cron Job

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

Both cron jobs delegate to use cases in the application layer:
- `apps/backend/src/application/use-cases/UpdateTokenPricesUseCase.ts`
- `apps/backend/src/application/use-cases/SyncWalletBalancesUseCase.ts`

This follows the clean architecture pattern, keeping business logic separate from infrastructure concerns.

### Service Dependencies

The use cases leverage existing services:
- `PricingService` - Fetches prices from external APIs
- `BlockchainServiceManager` - Fetches wallet balances from blockchain APIs
- `TokenRepository` - Database access for tokens
- `HoldingRepository` - Database access for holdings

## Monitoring and Logging

All cron jobs include comprehensive logging:

**Pricing Cron Job logs**:
- Start/end of execution
- Number of tokens processed
- Success/failure counts
- Execution duration
- Individual token errors

**Wallet Balances Cron Job logs**:
- Start/end of execution
- Number of accounts processed
- Holdings updated/created/removed
- Execution duration
- Individual wallet errors

**Log Component**: Both jobs use component loggers with identifiers:
- `cron:pricing` - Pricing cron job
- `cron:wallet-balances` - Wallet balances cron job

## Configuration

Cron jobs are configured in `apps/backend/src/index.ts`:

```typescript
import { cron } from '@elysiajs/cron';
import { executePricingCronJob, executeWalletBalancesCronJob } from './infrastructure/cron';

const app = new Elysia()
  .use(
    cron({
      name: 'pricing-cron',
      pattern: '0,30 * * * *',
      run: executePricingCronJob,
    })
  )
  .use(
    cron({
      name: 'wallet-balances-cron',
      pattern: '*/15 * * * *',
      run: executeWalletBalancesCronJob,
    })
  )
```

## Error Handling

Both cron jobs implement robust error handling:

1. **Non-blocking errors**: Individual token/wallet failures don't stop the entire job
2. **Error logging**: All errors are logged with context for debugging
3. **Graceful degradation**: Jobs continue on next schedule even if current execution fails
4. **No crashes**: Exceptions are caught and logged, preventing server crashes

## Testing

To test cron jobs manually:

1. Start the backend server:
   ```bash
   cd apps/backend
   bun dev
   ```

2. Monitor logs for cron job execution:
   - Pricing cron runs at :00 and :30 minutes
   - Wallet balances cron runs every 15 minutes

3. Check logs for execution results and any errors

## Future Improvements

Potential enhancements:
- Add configuration for cron schedules via environment variables
- Add metrics/monitoring dashboard for cron job execution
- Add manual trigger endpoints for admin users
- Add cron job health checks and alerting
- Add distributed locking for running in multi-instance deployments
