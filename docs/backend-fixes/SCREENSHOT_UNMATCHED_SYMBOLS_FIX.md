# Screenshot Upload - Unmatched Token Symbols Fix

**Date**: October 22, 2025
**Status**: ✅ Fixed
**Component**: Backend - AIService

## Problem

When uploading screenshots with financial holdings, the AI correctly extracted symbols like XUU and XEQT, but these holdings were not appearing on the frontend. The issue occurred during the token validation phase.

### Root Cause

In `apps/backend/src/application/services/AIService.ts`, the `validateAndFilterPortfolio` method was filtering out holdings where token validation failed (when `!validationResult.isValid`):

```typescript
if (!validationResult.isValid) {
  this.logWarning("Token validation failed", {
    symbol: holding.symbol,
    error: validationResult.error,
  });
  return null; // ❌ This was filtering out the holding completely
}
```

When a symbol like XUU or XEQT couldn't be found in:

- Finnhub (for stocks/ETFs)
- CoinGecko (for crypto)

The `TokenValidationService.validateToken()` returned `isValid: false`, causing the holding to be filtered out before reaching the frontend.

## Solution

Modified the `validateAndFilterPortfolio` method to **always return holdings** that pass the confidence threshold, even when token validation fails. This allows users to make their own decisions about unmatched tokens on the frontend.

### Code Changes

**File**: `apps/backend/src/application/services/AIService.ts`

Changed from filtering out invalid tokens to returning them with original parsed data:

```typescript
if (!validationResult.isValid) {
  this.logInfo(
    "Token validation failed - returning holding for user decision",
    {
      symbol: holding.symbol,
      error: validationResult.error,
    }
  );
  // ✅ Return the holding with original parsed data
  // This allows users to manually select the correct token from the frontend
  return holding;
}
```

Similarly for validation errors:

```typescript
catch (error) {
  this.logWarning("Token validation error - returning holding for user decision", {
    symbol: holding.symbol,
    error: error instanceof Error ? error.message : "Unknown error",
  });
  // ✅ Return the holding with original parsed data
  // This allows users to manually select the correct token from the frontend
  return holding;
}
```

### Updated Behavior

1. **AI Extraction**: AI parses screenshot and extracts holdings (e.g., XUU, XEQT)
2. **Confidence Filtering**: Only holdings below `minConfidence` threshold are filtered out
3. **Token Validation**: Attempts to validate each symbol against Finnhub and CoinGecko
4. **Success Case**: If validation succeeds, enrich holding with provider metadata
5. **Failure Case**: If validation fails, **still return the holding** with original parsed symbol
6. **Frontend Display**: All holdings (validated or not) appear on the frontend
7. **User Decision**: User can manually search and select the correct token for unmatched symbols

## Benefits

- ✅ No data loss - all AI-extracted holdings reach the frontend
- ✅ User empowerment - users can manually resolve ambiguous symbols
- ✅ Better UX - users see what was parsed and can make corrections
- ✅ Flexibility - handles edge cases like regional ETFs (XUU, XEQT) not in global databases

## Testing Recommendations

1. Upload screenshot with Canadian ETFs (XUU, XEQT)
2. Verify holdings appear on frontend with parsed symbols
3. Verify token search allows manual selection
4. Test with other regional/niche symbols not in Finnhub/CoinGecko
5. Verify validated tokens still get enriched with provider metadata

## Related Files

- `apps/backend/src/application/services/AIService.ts` - Main fix location
- `apps/backend/src/application/services/TokenValidationService.ts` - Validation logic
- `apps/backend/src/application/use-cases/ParseScreenshotUseCase.ts` - Orchestration
- `apps/frontendV2/src/components/add-data/ScreenshotUploadStep.tsx` - Frontend display

## Impact

- **Low Risk**: Only changes filtering behavior, doesn't affect core parsing logic
- **Backward Compatible**: Existing validated tokens still work the same way
- **Positive UX**: Users now see all parsed holdings instead of mysterious disappearing data
