#!/bin/bash
#
# 30-Minute Cron Job Script
# Updates token prices
#
# Schedule: 0,30 * * * * (Every 30 minutes at :00 and :30)
# Usage: bash scripts/cron-30min.sh
#

set -e

echo "🕐 Starting 30-minute cron tasks..."

# Navigate to cron app directory
cd "$(dirname "$0")/../apps/cron"

# Set environment variable to enable cron-specific database optimizations
export IS_CRON_JOB=true

# Run the cron tasks
bun run src/index.ts --tasks=pricing

echo "✅ 30-minute cron tasks completed"
