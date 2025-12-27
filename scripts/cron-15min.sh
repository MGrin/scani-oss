#!/bin/bash
#
# 15-Minute Cron Job Script
# Syncs wallet balances, exchange balances, and Plaid balances
#
# Schedule: */15 * * * * (Every 15 minutes)
# Usage: bash scripts/cron-15min.sh
#

set -e

echo "🕐 Starting 15-minute cron tasks..."

# Navigate to cron app directory
cd "$(dirname "$0")/../apps/cron"

# Run the cron tasks
bun run src/index.ts --tasks=wallet-balances,exchange-balances,plaid-balances

echo "✅ 15-minute cron tasks completed"
