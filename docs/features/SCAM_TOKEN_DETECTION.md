# Scam Token Detection Feature

## Overview

The scam token detection feature automatically identifies and filters out likely scam tokens when users import crypto wallets. EVM-based blockchains are notorious for scam tokens that appear in user wallets without consent, and this feature helps maintain a clean portfolio view.

## Implementation

### Database Changes

**Migration**: `add_is_scam_probability_to_tokens`
- Added `is_scam_probability` column to `tokens` table
- Type: `REAL` (0-1 range)
- Default: 0
- Includes CHECK constraint to ensure value is between 0 and 1

**Schema Update**: `packages/core/src/database/schema.ts`
- Added `isScamProbability` field to tokens table definition

### Core Components

#### 1. ScamTokenDetectionService

**Location**: `packages/core/src/services/ScamTokenDetectionService.ts`

**Purpose**: Calculates scam probability based on heuristics

**Detection Criteria**:
- **URL or TLD pattern** (+0.5 probability): Detects URLs, domain patterns, and TLDs like "GIVEAWAYSCOM" or "visit.me"
- **Suspicious words** (+0.4 probability): visit, claim, airdrop, bonus, reward, free, voucher, swap, ponzi, fomo, giveaway, etc.
- **Compound scam pattern** (+0.3 probability): Combination of suspicious words + URL/TLD (e.g., "USDTGIVEAWAYSCOM")
- **Excessively long names** (+0.2 probability): More than 5 words or 50 characters
- **Emoji in name/symbol** (+0.2 probability): 🎁, 🚀, etc.
- **Common symbol with recent creation** (+0.3 probability): e.g., "USDT" created 6 months ago
- **No pricing data** (+0.4 probability): Token not found on CoinGecko or DeFiLlama

**Threshold**: Tokens with probability >= 0.7 are filtered from user views

#### 2. Token Creation Integration

**Location**: `packages/core/src/services/TokenService.ts`

When a new crypto token is imported from blockchain:
1. `findOrCreateTokenFromIntegration()` is called
2. For new tokens, scam probability is calculated using `ScamTokenDetectionService`
3. Token is created with the calculated `isScamProbability` value
4. Logged for monitoring purposes

#### 3. Holdings Filtering

**Location**: `packages/core/src/repositories/HoldingRepository.ts`

Updated methods to filter scam tokens:
- `findByUser()`: Filters tokens with scam probability < 0.7
- `findByUserWithFullDetails()`: Includes filter in WHERE clause
- `findByAccount()`: Filters tokens with scam probability < 0.7

**Constant**: `SCAM_PROBABILITY_THRESHOLD = 0.7`

#### 4. Token Search/Selection Filtering

**Location**: `apps/backend/src/presentation/routers/tokens.ts`

Updated endpoints to filter scam tokens from UI:
- `tokens.getAll`: Returns only tokens with scam probability < 0.7
- `tokens.search`: Filters database results to exclude scam tokens

This ensures scam tokens are NEVER shown in:
- Token selection dropdowns
- Search results
- Token lists in the UI

**Constant**: `SCAM_PROBABILITY_THRESHOLD = 0.7`

### Maintenance Script

**Location**: `packages/core/src/scripts/updateTokenScamProbabilities.ts`

**Purpose**: Calculate and update scam probabilities for existing tokens

**Usage**:
```bash
bun run packages/core/src/scripts/updateTokenScamProbabilities.ts
```

**Process**:
1. Fetches all crypto tokens
2. Checks if each token has pricing data
3. Calculates scam probability
4. Updates database in batches of 100
5. Logs high-risk tokens (probability >= 0.7)

## Complete Filtering Implementation

Scam tokens are filtered at **ALL** user-facing layers:

### 1. Holdings/Portfolio Views
- `HoldingRepository.findByUser()` - User's holdings list
- `HoldingRepository.findByUserWithFullDetails()` - Detailed holdings with account info
- `HoldingRepository.findByAccount()` - Holdings for specific account

### 2. Token Selection/Search
- `tokens.getAll` - All tokens list (dropdowns)
- `tokens.search` - Token search functionality

### 3. Result
✅ Scam tokens (probability >= 0.7) are **NEVER** shown in:
- Portfolio/dashboard
- Holdings lists
- Token search results
- Token selection dropdowns
- Any user-facing UI component

## User Impact

### Before Implementation
When a user imports a wallet with many tokens (including scam tokens):
- All tokens would appear in their portfolio
- Portfolio would be cluttered with worthless scam tokens
- User would need to manually hide each one
- Scam tokens would appear in search dropdowns

### After Implementation
- Legitimate tokens with low scam probability appear normally
- Likely scam tokens (probability >= 0.7) are automatically hidden everywhere
- Clean portfolio view from the start
- No scam tokens in search/selection interfaces
- Scam tokens still exist in database but are filtered from all queries

## Example Scam Tokens

These would receive high scam probabilities:

1. **"Visit-scam.com to claim reward 🎁"**
   - URL in name: +0.4
   - Suspicious words (visit, claim, reward): +0.3
   - Emoji: +0.2
   - No pricing data: +0.4
   - **Total: 1.0 (capped)**

2. **"USDT"** (created last week)
   - Common symbol but recent: +0.3
   - No pricing data: +0.4
   - **Total: 0.7**

3. **"Free Airdrop Token 🚀 Visit Our Website Now"**
   - Suspicious words (free, airdrop, visit): +0.3
   - Excessively long name: +0.2
   - Emoji: +0.2
   - No pricing data: +0.4
   - **Total: 1.0 (capped)**

## Technical Notes

### Scope
- Only applies to **crypto tokens**
- Stocks, fiat currencies, and other token types are not subject to scam detection
- This is enforced at both the service and repository levels

### Performance
- Scam detection runs only during token creation
- Holdings queries include lightweight filter (simple numeric comparison)
- Batch processing for historical tokens

### Configuration
The threshold and detection weights can be adjusted in `ScamTokenDetectionService`:
- `SCAM_PROBABILITY_THRESHOLD`: Currently 0.7
- Individual heuristic weights can be tuned based on false positive/negative rates

### Future Enhancements
Potential improvements:
1. Machine learning model trained on known scam tokens
2. Integration with blockchain security APIs (e.g., GoPlus Security)
3. Community-driven scam token reporting
4. Whitelist for false positives
5. User preference to adjust threshold
6. Periodic re-evaluation of token scam scores

## Testing

### Manual Testing Steps
1. Import a wallet with known scam tokens
2. Verify scam tokens are not visible in holdings
3. Check database to confirm tokens exist with high `is_scam_probability`
4. Run the migration script and verify it completes successfully
5. Check logs for high-risk token detections

### Test Cases
- Token with URL in symbol
- Token with suspicious words
- Token with emoji
- Legitimate token created recently (should NOT be flagged)
- Token without pricing data but legitimate name

## Deployment

1. Apply database migration: `add_is_scam_probability_to_tokens`
2. Deploy updated code
3. Run maintenance script: `bun run packages/core/src/scripts/updateTokenScamProbabilities.ts`
4. Monitor logs for any issues
5. Check user feedback on portfolio cleanliness

## Monitoring

Key metrics to track:
- Percentage of tokens flagged as scams
- False positive reports from users
- Performance impact on holdings queries
- Distribution of scam probability scores
