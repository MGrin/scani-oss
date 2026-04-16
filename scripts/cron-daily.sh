#!/bin/bash
#
# Daily Cron Job Script
# Applies APY interest payouts to configured holdings
#
# Schedule: 0 0 * * * (Daily at midnight UTC)
# Usage: bash scripts/cron-daily.sh
#

set -e

echo "Starting daily cron tasks..."

# Navigate to cron app directory
cd "$(dirname "$0")/../apps/cron"

# Set environment variable to enable cron-specific database optimizations
export IS_CRON_JOB=true

# Run the cron tasks
bun run src/index.ts --tasks=apy-payouts

echo "Daily cron tasks completed"
