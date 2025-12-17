# Plaid Token Exchange Error Fix

**Issue**: Users were seeing a generic "Failed to exchange Plaid token" error message when redirected back from Plaid Link, making it impossible to debug the actual cause of the failure.

**Root Cause Analysis**:
1. The `PlaidApiService.exchangePublicToken()` method was only extracting the `error_message` from Plaid API errors
2. The `ExchangePlaidTokenUseCase` was not logging enough details for debugging
3. The `plaid` router was catching all errors and replacing them with a generic message
4. Plaid API errors include important fields: `error_code`, `error_type`, `error_message`, and HTTP status code
5. Missing environment variables weren't providing helpful guidance

## Changes Made

### 1. Enhanced PlaidApiService Error Messages
**File**: `packages/integrations/src/services/PlaidApiService.ts`

**Before**:
```typescript
if (!response.ok) {
  const error = await response.json();
  throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
}
```

**After**:
```typescript
if (!response.ok) {
  const error = await response.json();
  const errorCode = (error as any)?.error_code || 'UNKNOWN';
  const errorType = (error as any)?.error_type || 'API_ERROR';
  const errorMessage = (error as any)?.error_message || response.statusText;
  
  throw new Error(
    `Plaid API error [${errorCode}]: ${errorMessage} (type: ${errorType}, status: ${response.status})`
  );
}
```

**Impact**: Now includes error code (e.g., `INVALID_PUBLIC_TOKEN`), error type, and HTTP status for better debugging.

### 2. Improved Use Case Logging
**File**: `packages/core/src/use-cases/ExchangePlaidTokenUseCase.ts`

Added detailed logging:
- Debug log before calling Plaid API with public token length
- Enhanced error logging with error message, stack trace, and full error details
- Includes userId and plaidInstitutionId in error logs for tracing

### 3. Better Router Error Handling
**File**: `apps/backend/src/presentation/routers/plaid.ts`

**Before**:
```typescript
} catch (error) {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Failed to exchange Plaid token',
    cause: error,
  });
}
```

**After**:
```typescript
} catch (error) {
  // Extract detailed error message from Plaid API if available
  const errorMessage = error instanceof Error ? error.message : 'Failed to exchange Plaid token';
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: errorMessage,
    cause: error,
  });
}
```

**Impact**: Frontend now receives the actual Plaid API error message instead of generic text.

### 4. Environment Variable Validation
**File**: `packages/integrations/src/factories/plaidFactory.ts`

**Before**:
```typescript
if (!clientId || !secret) {
  throw new Error('PLAID_CLIENT_ID and PLAID_SECRET environment variables are required');
}
```

**After**:
```typescript
if (!clientId || !secret) {
  const missingVars = [];
  if (!clientId) missingVars.push('PLAID_CLIENT_ID');
  if (!secret) missingVars.push('PLAID_SECRET');
  throw new Error(
    `Missing required Plaid environment variables: ${missingVars.join(', ')}. ` +
    'Please set these in your .env file. See apps/backend/.env.example for reference.'
  );
}
```

**Impact**: Clearer error messages with guidance on where to find configuration examples.

### 5. Documentation Update
**File**: `apps/backend/.env.example`

Added Plaid configuration section:
```bash
# Plaid Configuration (for bank account integration)
# Get credentials from: https://dashboard.plaid.com/developers/keys
PLAID_ENV=sandbox
PLAID_CLIENT_ID=your_plaid_client_id_here
PLAID_SECRET=your_plaid_secret_here
```

## Common Plaid Error Codes

After this fix, users will see specific error codes that can be debugged:

| Error Code | Description | Solution |
|------------|-------------|----------|
| `INVALID_PUBLIC_TOKEN` | Public token is invalid or expired | Public tokens expire after 30 minutes. User needs to reconnect through Plaid Link |
| `INVALID_CREDENTIALS` | Plaid API credentials are invalid | Check `PLAID_CLIENT_ID` and `PLAID_SECRET` environment variables |
| `ITEM_LOGIN_REQUIRED` | User needs to re-authenticate | User's bank credentials have changed or expired |
| `INVALID_PRODUCT` | Product not enabled for institution | Check Plaid dashboard for product enablement |
| `INSTITUTION_DOWN` | Bank institution is temporarily unavailable | Wait and try again later |

## Testing the Fix

### Backend Logs
When an error occurs, you'll now see detailed logs like:
```
ERROR [use-case:exchange-plaid-token]: Failed to exchange Plaid token
  userId: "user-123"
  plaidInstitutionId: "ins_123"
  errorMessage: "Plaid API error [INVALID_PUBLIC_TOKEN]: public token is expired (type: INVALID_REQUEST, status: 400)"
  errorStack: "Error: Plaid API error [INVALID_PUBLIC_TOKEN]..."
```

### Frontend Error Display
Users will see specific error messages in the UI:
- Before: "Failed to exchange Plaid token"
- After: "Plaid API error [INVALID_PUBLIC_TOKEN]: public token is expired (type: INVALID_REQUEST, status: 400)"

## Debugging Steps

1. **Check Backend Logs** (Render):
   - Navigate to Render dashboard
   - Select the backend service
   - View logs for detailed error messages with error codes

2. **Verify Environment Variables**:
   ```bash
   echo $PLAID_CLIENT_ID
   echo $PLAID_SECRET
   echo $PLAID_ENV
   ```

3. **Check Plaid Dashboard**:
   - Visit https://dashboard.plaid.com/
   - Verify API keys are correct
   - Check if the institution is supported in your environment

4. **Common Issues**:
   - **Public token expired**: Public tokens are single-use and expire after 30 minutes
   - **Wrong environment**: Ensure `PLAID_ENV` matches your Plaid dashboard keys
   - **Missing API keys**: Check that environment variables are set correctly

## Related Files

- `packages/integrations/src/services/PlaidApiService.ts` - Plaid API communication
- `packages/core/src/use-cases/ExchangePlaidTokenUseCase.ts` - Business logic for token exchange
- `apps/backend/src/presentation/routers/plaid.ts` - tRPC router endpoints
- `apps/frontendV2/src/hooks/usePlaidLink.ts` - Frontend hook for Plaid integration
- `apps/frontendV2/src/components/add-data/PlaidLinkStep.tsx` - UI component

## Next Steps

If errors persist after this fix:
1. Check backend logs for the specific error code
2. Refer to [Plaid API Error Documentation](https://plaid.com/docs/errors/)
3. Verify environment variables are correctly set
4. Ensure Plaid Link SDK is properly initialized in frontend
5. Check that the public token is being sent immediately after receiving it (before 30-minute expiration)
