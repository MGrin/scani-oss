# Cron Jobs

This document describes the scheduled cron jobs in Scani.

## Overview

Cron jobs have been extracted into a separate `apps/cron` application that runs independently from the backend. The cron app uses a CLI interface to execute specific tasks on demand, allowing external schedulers (like Render Cron Jobs) to trigger them at specific intervals.

## Architecture

### Cron App Structure

- **Location**: `apps/cron/`
- **Entry Point**: `apps/cron/src/index.ts`
- **Job Implementations**: `apps/cron/src/jobs/`
- **CLI Interface**: `bun run apps/cron/src/index.ts --tasks=task1,task2`

### Execution Model

The cron app takes a comma-separated list of task names via the `--tasks` parameter and executes them sequentially:

```bash
# Run a single task
bun run apps/cron/src/index.ts --tasks=pricing

# Run multiple tasks
bun run apps/cron/src/index.ts --tasks=pricing,wallet-balances,exchange-balances

# Run all tasks (useful for testing)
bun run apps/cron/src/index.ts --tasks=pricing,wallet-balances,exchange-balances,plaid-balances
```

### External Scheduling

Cron scheduling is now managed externally (e.g., via Render Cron Jobs). This provides:
- Better separation of concerns
- Independent scaling of cron jobs
- Easier monitoring and debugging
- More flexible scheduling options

## Active Cron Jobs

### 1. Pricing Cron Job

**Purpose**: Updates token prices for all tokens that have active holdings.

**Task Name**: `pricing`  
**Recommended Schedule**: Every 30 minutes  
**Render Cron Pattern**: `0,30 * * * *` (at :00 and :30)  
**Command**: `bun run apps/cron/src/index.ts --tasks=pricing`

**Implementation**: 
- Use Case: `UpdateTokenPricesUseCase`
- Cron Job: `apps/cron/src/jobs/PricingCronJob.ts`

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

**Task Name**: `exchange-balances`  
**Recommended Schedule**: Every 15 minutes  
**Render Cron Pattern**: `*/15 * * * *`  
**Command**: `bun run apps/cron/src/index.ts --tasks=exchange-balances`

**Implementation**:
- Use Case: `SyncExchangeBalancesUseCase`
- Cron Job: `apps/cron/src/jobs/ExchangeBalancesCronJob.ts`

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

**Task Name**: `wallet-balances`  
**Recommended Schedule**: Every 15 minutes  
**Render Cron Pattern**: `*/15 * * * *`  
**Command**: `bun run apps/cron/src/index.ts --tasks=wallet-balances`

**Implementation**:
- Use Case: `SyncWalletBalancesUseCase`
- Cron Job: `apps/cron/src/jobs/WalletBalancesCronJob.ts`

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

### 4. Plaid Balances Sync Cron Job

**Purpose**: Synchronizes Plaid account balances for all accounts imported via Plaid integration.

**Task Name**: `plaid-balances`  
**Recommended Schedule**: Every 15 minutes  
**Render Cron Pattern**: `*/15 * * * *`  
**Command**: `bun run apps/cron/src/index.ts --tasks=plaid-balances`

**Implementation**:
- Use Case: `SyncPlaidBalancesUseCase`
- Cron Job: `apps/cron/src/jobs/PlaidBalancesCronJob.ts`

**How it works**:
1. Finds all accounts with Plaid credentials
2. For each Plaid item, fetches current balances from Plaid API
3. Updates existing holdings with new balances
4. Creates new holdings when account owns new assets
5. Updates account metadata with last sync timestamp
6. Respects Plaid API rate limits

**Key Features**:
- Supports all Plaid-connected financial institutions
- Automatically discovers new accounts and balances
- Non-blocking operation - individual item failures don't stop the entire sync
- Respects Plaid API rate limits

## Architecture

### Use Cases Layer

All cron jobs delegate to use cases in the application layer:
- `@scani/core/use-cases/UpdateTokenPricesUseCase.ts` - Price updates
- `@scani/core/use-cases/SyncExchangeBalancesUseCase.ts` - Exchange balance sync
- `@scani/core/use-cases/SyncWalletBalancesUseCase.ts` - Wallet balance sync
- `@scani/core/use-cases/SyncPlaidBalancesUseCase.ts` - Plaid balance sync

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
- `cron:main` - Main cron runner
- `cron:pricing` - Pricing cron job
- `cron:exchange-balances` - Exchange balances cron job
- `cron:wallet-balances` - Wallet balances cron job
- `cron:plaid-balances` - Plaid balances cron job

## Configuration

### Local Development

Run the cron app locally for testing:

```bash
# Run a single task
cd apps/cron
bun run src/index.ts --tasks=pricing

# Run multiple tasks
bun run src/index.ts --tasks=pricing,wallet-balances,exchange-balances

# Or use the dev script from root
bun dev:cron
```

### Render Configuration

Cron jobs are scheduled as separate Render Cron Jobs using bash scripts:

**15-Minute Sync Job** (wallet, exchange, and Plaid balances):
```bash
Command: bash scripts/cron-15min.sh
Schedule: */15 * * * * (Every 15 minutes)
```

**30-Minute Pricing Job**:
```bash
Command: bash scripts/cron-30min.sh
Schedule: 0,30 * * * * (Every 30 minutes at :00 and :30)
```

**Note**: The scripts are located in `scripts/cron-15min.sh` and `scripts/cron-30min.sh`. 
Modify these scripts to change the list of tasks without updating Render configuration.

## Error Handling

All cron jobs implement robust error handling:

1. **Non-blocking errors**: Individual token/wallet/account failures don't stop the entire job
2. **Error logging**: All errors are logged with context for debugging and captured in Sentry
3. **Exit codes**: The cron app exits with code 1 if any task fails, code 0 if all succeed
4. **Sequential execution**: Tasks are executed one at a time in the order specified
5. **Rate limit handling**: Exchange and blockchain API rate limits are respected to avoid temporary bans

## Testing

To test cron jobs manually:

1. Run individual tasks:
   ```bash
   cd apps/cron
   bun run src/index.ts --tasks=pricing
   ```

2. Run multiple tasks:
   ```bash
   bun run src/index.ts --tasks=wallet-balances,exchange-balances,plaid-balances
   ```

3. Monitor logs for execution results and any errors

4. Test with actual data:
   - Add exchange credentials (Binance/Kraken) through the frontend
   - Import wallet addresses
   - Connect Plaid accounts
   - Run the relevant sync tasks
   - Check logs for `cron:*` output

## Future Improvements

Potential enhancements:
- Add parallel task execution for independent tasks
- Add retry logic for transient failures
- Add metrics/monitoring dashboard for cron job execution
- Add manual trigger endpoints for admin users via API
- Add health check endpoint for cron jobs
- Add distributed locking for running in multi-instance deployments
