# Render Cron Jobs Setup Guide

This guide explains how to configure Scani cron jobs on Render.

## Prerequisites

- Scani repository deployed on Render
- Backend service already running
- Access to Render dashboard with appropriate permissions

## Cron Job Services to Create

### 1. 15-Minute Sync Job

This job syncs wallet balances, exchange balances, and Plaid balances every 15 minutes.

**Configuration:**
- **Name**: `scani-cron-15min`
- **Type**: Cron Job
- **Repository**: `https://github.com/MGrin/scani`
- **Branch**: `main`
- **Build Command**: `bun install`
- **Command**: `bash scripts/cron-15min.sh`
- **Schedule**: `*/15 * * * *` (Every 15 minutes)
- **Region**: `singapore` (same as backend for lower latency)
- **Plan**: `starter` (should be sufficient)

**Build Filters (optional but recommended):**
- Paths to watch: `apps/cron`, `packages/core`, `packages/shared`, `packages/integrations`

**Environment Variables:**
Copy all environment variables from the backend service:
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SENTRY_DSN` (optional)
- `NODE_ENV=production`
- Any exchange API keys (BINANCE_API_KEY, KRAKEN_API_KEY, etc.)
- Any blockchain API keys

### 2. 30-Minute Pricing Job

This job updates token prices every 30 minutes.

**Configuration:**
- **Name**: `scani-cron-30min`
- **Type**: Cron Job
- **Repository**: `https://github.com/MGrin/scani`
- **Branch**: `main`
- **Build Command**: `bun install`
- **Command**: `bash scripts/cron-30min.sh`
- **Schedule**: `0,30 * * * *` (Every 30 minutes at :00 and :30)
- **Region**: `singapore` (same as backend for lower latency)
- **Plan**: `starter` (should be sufficient)

**Build Filters (optional but recommended):**
- Paths to watch: `apps/cron`, `packages/core`, `packages/shared`

**Environment Variables:**
Copy all environment variables from the backend service:
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SENTRY_DSN` (optional)
- `NODE_ENV=production`
- Price provider API keys (if any)

## Setup Steps

1. **Navigate to Render Dashboard**
   - Go to https://dashboard.render.com
   - Select the Scani workspace

2. **Create 15-Minute Sync Cron Job**
   - Click "New +" → "Cron Job"
   - Fill in the configuration details from above
   - Add all required environment variables
   - Click "Create Cron Job"

3. **Create 30-Minute Pricing Cron Job**
   - Click "New +" → "Cron Job"
   - Fill in the configuration details from above
   - Add all required environment variables
   - Click "Create Cron Job"

4. **Verify Setup**
   - Wait for the first scheduled run
   - Check logs in Render dashboard
   - Verify data is being updated in the database
   - Monitor Sentry for any errors

## Monitoring

### Logs
- View logs in Render dashboard for each cron job
- Logs include:
  - Start/end timestamps
  - Task execution summaries
  - Success/failure counts
  - Error details

### Sentry Integration
- Errors are automatically captured in Sentry
- Check Sentry dashboard for any issues
- Failed tasks will trigger Sentry alerts

### Database Checks
- Check `token_prices.updated_at` to verify pricing updates
- Check `accounts.last_synced_at` to verify balance syncs
- Check `holdings.updated_at` to verify holdings updates

## Troubleshooting

### Cron Job Fails to Start
- Verify build command is correct
- Check environment variables are set
- Ensure Bun is available in the environment

### Task Execution Errors
- Check logs for specific error messages
- Verify API keys are correct and not expired
- Check rate limits on external APIs
- Verify database connectivity

### Missing Updates
- Verify cron schedule is correct
- Check if previous run is still executing
- Review logs for task-specific errors
- Ensure accounts/wallets are properly configured

## Cost Optimization

- **Build Filters**: Use path filters to avoid unnecessary builds
- **Region**: Use same region as backend for lower latency
- **Plan**: Start with `starter` plan and upgrade if needed
- **Schedules**: Adjust frequencies based on user needs

## Future Enhancements

- Separate cron jobs for each task type (more granular control)
- Add health check endpoints
- Implement distributed locking for multi-region deployments
- Add retry logic with exponential backoff
- Create alerting webhooks for critical failures
