# Database Maintenance Scripts

This directory contains utility scripts for database maintenance and data migrations.

## Update Token Scam Probabilities

**Script**: `updateTokenScamProbabilities.ts`

This script calculates and updates scam probability scores for all existing crypto tokens in the database.

### What It Does

1. Fetches all crypto tokens from the database
2. For each token:
   - Checks if pricing data exists (from CoinGecko, DeFiLlama, etc.)
   - Calculates a scam probability score (0-1) based on:
     - URL patterns in name/symbol
     - Suspicious keywords (visit, claim, airdrop, etc.)
     - Excessively long names
     - Emoji in name/symbol
     - Common symbols with recent creation dates
     - Lack of pricing data
3. Updates the `is_scam_probability` field in the database

### Usage

```bash
# From project root
bun run packages/core/src/scripts/updateTokenScamProbabilities.ts
```

### When to Run

- After initial deployment of scam detection feature
- Periodically to refresh scam scores for existing tokens
- After major changes to the scam detection algorithm

### Output

The script logs:
- Progress information for each batch
- High-risk tokens detected (probability >= 0.7)
- Final statistics including total tokens processed and percentage flagged as high-risk

### Notes

- The script processes tokens in batches of 100 to avoid overwhelming the database
- Tokens with scam probability >= 0.7 are automatically filtered from user holdings queries
- Only crypto tokens are processed; other token types (fiat, stocks, etc.) are not subject to scam detection
