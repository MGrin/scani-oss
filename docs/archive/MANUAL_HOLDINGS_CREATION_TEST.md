# Manual Holdings Creation Test Plan

**Purpose**: Verify that the holdings creation and pricing fixes work correctly.

## Prerequisites

1. Backend server running: `cd apps/backend && bun dev`
2. Frontend running: `cd apps/frontend && bun dev`
3. User account with:
   - At least one institution
   - At least one account
   - Base currency set (e.g., USD)

## Test Cases

### Test 1: Create Holding with Existing Token
**Objective**: Verify basic holdings creation works

**Steps**:
1. Navigate to "Add Data" page
2. Select "Manual Entry"
3. Select existing account
4. Search for "AAPL" (or another known stock)
5. Select AAPL from dropdown
6. Enter balance: 10
7. Click "Add Holding"

**Expected Result**:
- ✅ Success message appears
- ✅ Holding appears in database immediately
- ✅ Holding visible in UI
- ✅ Price is fetched and displayed (not $0.00)
- ✅ Backend logs show "Holding created successfully in database"
- ✅ Backend logs show "Successfully fetched price for newly created holding"

**Check Database**:
```sql
SELECT h.id, h.balance, t.symbol, t.name, h.created_at
FROM holdings h
JOIN tokens t ON h.token_id = t.id
WHERE h.user_id = 'YOUR_USER_ID'
ORDER BY h.created_at DESC
LIMIT 1;

-- Verify NO zero prices in database
SELECT COUNT(*) as zero_price_count
FROM token_prices
WHERE price = '0';
-- Should be 0
```

---

### Test 2: Create Holding with New External Token (CoinGecko)
**Objective**: Verify token creation with proper metadata for crypto

**Steps**:
1. Navigate to "Add Data" page
2. Select "Manual Entry"
3. Select existing account
4. Search for "SOL" (Solana)
5. Select Solana from search results (should show as external token)
6. Enter balance: 5
7. Click "Add Holding"

**Expected Result**:
- ✅ Success message appears
- ✅ Token is created in database with CoinGecko metadata
- ✅ Holding is created
- ✅ Price is fetched from CoinGecko
- ✅ Backend logs show "External token created successfully with valid ID"
- ✅ Backend logs show "Structured CoinGecko metadata with ID for pricing"

**Check Database**:
```sql
-- Check token metadata structure
SELECT 
  id,
  symbol,
  name,
  provider_metadata::json->'coingecko'->>'id' as coingecko_id,
  provider_metadata::json->>'provider' as provider
FROM tokens
WHERE symbol = 'SOL'
ORDER BY created_at DESC
LIMIT 1;

-- Verify metadata has proper structure
-- Should have: provider='coingecko', coingecko.id='solana'

-- Check price was fetched
SELECT tp.price, tp.source, tp.timestamp
FROM token_prices tp
JOIN tokens t ON tp.token_id = t.id
WHERE t.symbol = 'SOL'
ORDER BY tp.timestamp DESC
LIMIT 1;

-- Price should be > 0
```

---

### Test 3: Create Holding with New External Token (Finnhub)
**Objective**: Verify token creation works for stocks

**Steps**:
1. Navigate to "Add Data" page
2. Select "Manual Entry"
3. Select existing account
4. Search for "MSFT" (if not already in database)
5. Select Microsoft from search results
6. Enter balance: 2
7. Click "Add Holding"

**Expected Result**:
- ✅ Success message appears
- ✅ Token created with Finnhub metadata
- ✅ Holding created
- ✅ Price fetched from Finnhub
- ✅ Backend logs show proper Finnhub symbol structure

**Check Database**:
```sql
-- Check token metadata
SELECT 
  symbol,
  name,
  provider_metadata::json->>'provider' as provider,
  provider_metadata::json->'finnhub'->>'symbol' as finnhub_symbol
FROM tokens
WHERE symbol = 'MSFT'
ORDER BY created_at DESC
LIMIT 1;

-- Should have: provider='finnhub', finnhub.symbol='MSFT'
```

---

### Test 4: Holdings Creation When Pricing Fails
**Objective**: Verify holdings are created even when pricing provider is down

**Setup**: Temporarily disable pricing (or test with a token that has no price data)

**Steps**:
1. Use a private token or obscure token
2. OR temporarily break CoinGecko API key
3. Try to create holding

**Expected Result**:
- ✅ Holding is still created successfully
- ✅ UI shows warning: "Holding Created (Price Unavailable)"
- ✅ Holding visible in database
- ✅ Backend logs show "Failed to fetch token price after holding creation - holding still created successfully"
- ⚠️ Price shows as unavailable in UI (not cached as $0 in DB)

**Check Database**:
```sql
-- Holding should exist
SELECT * FROM holdings WHERE id = 'NEW_HOLDING_ID';

-- NO zero price should be cached
SELECT COUNT(*) FROM token_prices 
WHERE token_id = 'NEW_TOKEN_ID' AND price = '0';
-- Should be 0
```

---

### Test 5: Verify No Zero Prices in Database
**Objective**: Confirm zero prices are never cached

**Steps**:
1. Run several holding creation operations
2. Include some that might fail pricing
3. Check database for zero prices

**Check Database**:
```sql
-- This query should return 0 rows
SELECT 
  tp.id,
  tp.token_id,
  t.symbol,
  tp.price,
  tp.source,
  tp.timestamp
FROM token_prices tp
JOIN tokens t ON tp.token_id = t.id
WHERE tp.price = '0' OR tp.price = '0.0' OR CAST(tp.price AS NUMERIC) = 0;

-- Expected: 0 rows
```

---

### Test 6: Multiple Holdings for Same Token
**Objective**: Ensure multiple holdings can be created

**Steps**:
1. Create holding for AAPL in Account A
2. Create another holding for AAPL in Account B
3. Verify both exist

**Expected Result**:
- ✅ Both holdings created
- ✅ Each holding has separate ID
- ✅ Price is fetched once and reused (cached)
- ✅ No duplicate tokens created

---

### Test 7: Transaction Creation
**Objective**: Verify opening balance transaction is created

**Steps**:
1. Create holding with balance > 0
2. Check transactions table

**Check Database**:
```sql
SELECT 
  t.id,
  t.holding_id,
  t.amount,
  tt.code as type,
  t.description,
  t.timestamp
FROM transactions t
JOIN transaction_types tt ON t.type_id = tt.id
WHERE t.holding_id = 'NEW_HOLDING_ID';

-- Should have one transaction with:
-- - type_id = 'deposit'
-- - amount = holding balance
-- - description = 'Opening balance - initial holding position'
```

---

## Backend Log Monitoring

Watch backend logs during testing for these key messages:

### Success Messages
```
✅ "Holding created successfully in database"
✅ "Successfully fetched price for newly created holding"
✅ "External token created successfully with valid ID"
✅ "Structured CoinGecko metadata with ID for pricing"
✅ "Created opening balance transaction"
```

### Expected Warnings (Non-blocking)
```
⚠️ "Failed to fetch token price after holding creation - holding still created successfully"
⚠️ "Token price returned as zero or invalid"
⚠️ "Skipping cache of zero/invalid price - failures should not be persisted"
```

### Error Messages (Should NOT appear)
```
❌ "Failed to create holding"
❌ "Failed to create token - no ID returned"
❌ "Transaction rollback"
```

---

## Post-Test Verification

### 1. Check Database Integrity
```sql
-- All holdings should have valid IDs
SELECT COUNT(*) as holdings_without_id
FROM holdings
WHERE id IS NULL;
-- Should be 0

-- All tokens should have valid IDs
SELECT COUNT(*) as tokens_without_id
FROM tokens
WHERE id IS NULL;
-- Should be 0

-- No zero prices in cache
SELECT COUNT(*) as zero_prices
FROM token_prices
WHERE CAST(price AS NUMERIC) = 0;
-- Should be 0

-- All holdings should have associated transactions
SELECT 
  COUNT(*) as holdings_without_transactions
FROM holdings h
LEFT JOIN transactions t ON h.id = t.holding_id
WHERE t.id IS NULL AND CAST(h.balance AS NUMERIC) > 0;
-- Should be 0
```

### 2. Check UI Consistency
- All created holdings should be visible
- Prices should be displayed (or show "unavailable", never "$0.00" from cache)
- Portfolio totals should be accurate
- No duplicate holdings

---

## Rollback Procedure (If Tests Fail)

If critical issues are found:

1. **Immediate**: Note the failing test case
2. **Capture**: Save backend logs showing the error
3. **Rollback**: 
   ```bash
   git log --oneline -5
   git revert <commit-hash-of-fix>
   ```
4. **Restart**: Restart backend server
5. **Notify**: Document what failed and why

---

## Success Criteria

All tests pass with:
- ✅ Holdings created successfully in every scenario
- ✅ Zero prices never appear in database
- ✅ Token metadata properly structured
- ✅ Pricing failures don't block holding creation
- ✅ Clear error messages and logging
- ✅ UI shows accurate data immediately after creation

---

**Test Date**: _______________  
**Tester**: _______________  
**Results**: _______________
