# Scripts Directory

This directory contains utility scripts for the Scani project.

## Cron Job Scripts

### `cron-15min.sh`

Executes 15-minute scheduled tasks:
- Wallet balance synchronization
- Exchange balance synchronization  
- Plaid account synchronization

**Usage:**
```bash
bash scripts/cron-15min.sh
```

**Render Schedule:** `*/15 * * * *` (every 15 minutes)

### `cron-30min.sh`

Executes 30-minute scheduled tasks:
- Token price updates

**Usage:**
```bash
bash scripts/cron-30min.sh
```

**Render Schedule:** `0,30 * * * *` (every 30 minutes at :00 and :30)

## Benefits of Using Scripts

1. **Easy Updates**: Modify task lists by editing the scripts instead of updating Render configuration
2. **Version Control**: Task configurations are tracked in Git
3. **Consistent Execution**: Same command works locally and in production
4. **Documentation**: Scripts serve as self-documenting code

## Modifying Task Lists

To add or remove tasks from a cron schedule:

1. Edit the appropriate script (`cron-15min.sh` or `cron-30min.sh`)
2. Update the `--tasks=` parameter with the new task list
3. Commit and push changes
4. Render will automatically use the updated script on next execution

**Example:**
```bash
# Before
bun run src/index.ts --tasks=wallet-balances,exchange-balances

# After (adding plaid-balances)
bun run src/index.ts --tasks=wallet-balances,exchange-balances,plaid-balances
```

No Render configuration changes needed!

## Other Scripts

### `check-env.ts`

TypeScript utility for checking environment variables.

### `migrate-bitcoin-wallet.sql`

SQL migration script for Bitcoin wallet schema updates.
