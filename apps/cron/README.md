# Scani Cron Jobs

CLI-based cron job runner for Scani. Executes scheduled tasks for syncing balances and updating prices.

## Overview

This app runs cron jobs that were previously embedded in the backend. It provides a CLI interface for executing specific tasks on demand, allowing external schedulers (like Render Cron Jobs) to trigger them.

## Installation

```bash
bun install
```

## Usage

### CLI Interface

```bash
# Run a single task
bun run src/index.ts --tasks=pricing

# Run multiple tasks
bun run src/index.ts --tasks=wallet-balances,exchange-balances,plaid-balances

# Development mode (runs all tasks)
bun dev
```

### Available Tasks

- **`pricing`**: Update token prices for all tokens with active holdings
- **`wallet-balances`**: Sync blockchain wallet balances
- **`exchange-balances`**: Sync exchange account balances (Binance, Kraken, etc.)
- **`plaid-balances`**: Sync Plaid account balances
- **`daily-digest`**: Send daily portfolio digest (requires Telegram bot - currently not implemented)

## Architecture

### Task Execution Flow

1. Parse CLI arguments to get list of tasks
2. Initialize TypeDI container and load all services
3. Initialize integration registry (Binance, Kraken, blockchain services, etc.)
4. Initialize Sentry for error tracking
5. Execute tasks sequentially
6. Log execution results and capture errors
7. Exit with code 0 (success) or 1 (failure)

### Dependencies

Each task uses a corresponding Use Case from `@scani/core/use-cases`:

- `UpdateTokenPricesUseCase` - Pricing task
- `SyncWalletBalancesUseCase` - Wallet balances task
- `SyncExchangeBalancesUseCase` - Exchange balances task
- `SyncPlaidBalancesUseCase` - Plaid balances task

### Error Handling

- Individual task failures don't stop execution of other tasks
- All errors are logged and captured in Sentry
- Exit code indicates overall success/failure
- Non-blocking errors (e.g., single wallet failure) are handled gracefully

## Configuration

### Environment Variables

The cron app requires the same environment variables as the backend:

```bash
# Database
DATABASE_URL=postgresql://...

# Supabase
SUPABASE_URL=https://...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Sentry (optional)
SENTRY_DSN=...

# Exchange APIs (optional, needed for exchange-balances task)
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
KRAKEN_API_KEY=...
KRAKEN_API_SECRET=...

# Blockchain APIs (optional, needed for wallet-balances task)
ETHERSCAN_API_KEY=...
TONSCAN_API_KEY=...
# ... other blockchain API keys

# Environment
NODE_ENV=production
```

## Development

### Local Testing

```bash
# Run pricing task
bun run src/index.ts --tasks=pricing

# Run all sync tasks
bun run src/index.ts --tasks=wallet-balances,exchange-balances,plaid-balances

# Run with watch mode
bun dev
```

### Linting

```bash
bun run lint
bun run lint:fix
```

### Type Checking

```bash
bun run type-check
```

## Deployment

See [Render Cron Setup Guide](../../docs/technical/RENDER_CRON_SETUP.md) for production deployment instructions.

### Recommended Schedules

**15-Minute Sync** (wallet, exchange, Plaid):
```bash
Schedule: */15 * * * *
Command: bash scripts/cron-15min.sh
```

**30-Minute Pricing**:
```bash
Schedule: 0,30 * * * *
Command: bash scripts/cron-30min.sh
```

**Note**: Bash scripts in `scripts/` directory wrap the CLI commands. 
To update task lists, modify the scripts instead of Render configuration.

## Monitoring

### Logs

All tasks include comprehensive logging:
- Task start/end timestamps
- Success/failure counts
- Execution duration
- Error details

Log identifiers:
- `cron:main` - Main runner
- `cron:pricing` - Pricing task
- `cron:wallet-balances` - Wallet sync task
- `cron:exchange-balances` - Exchange sync task
- `cron:plaid-balances` - Plaid sync task

### Sentry

Errors are automatically captured in Sentry with context:
- Task name
- Error message and stack trace
- Execution duration

### Exit Codes

- `0` - All tasks completed successfully
- `1` - One or more tasks failed

## Troubleshooting

### Task Execution Errors

Check logs for specific error messages:

```bash
# View recent logs (if running via Render)
# Go to Render Dashboard → Cron Job → Logs

# Common issues:
# - Missing environment variables
# - Database connection failures
# - API rate limits exceeded
# - Invalid credentials for exchanges
```

### Database Connection Issues

Ensure `DATABASE_URL` is correct and the database is accessible from the cron job environment.

### API Rate Limits

External APIs have rate limits:
- CoinGecko: ~50 calls/minute
- Finnhub: Depends on plan
- Exchange APIs: Varies by exchange
- Blockchain explorers: Varies by service

Tasks automatically respect rate limits and handle errors gracefully.

## Future Improvements

- [ ] Parallel task execution for independent tasks
- [ ] Retry logic with exponential backoff
- [ ] Task-specific timeouts
- [ ] Health check endpoint
- [ ] Metrics collection and reporting
- [ ] Distributed locking for multi-instance deployments
