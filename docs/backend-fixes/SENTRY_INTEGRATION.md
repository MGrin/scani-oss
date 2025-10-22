# Sentry Integration - Backend

**Date**: October 22, 2025
**Status**: ✅ Implemented
**Component**: Backend - Error Tracking & Monitoring

## Overview

Sentry integration has been added to the Scani backend for comprehensive error tracking, performance monitoring, and debugging capabilities. The integration uses `@sentry/bun` for optimal compatibility with the Bun runtime.

## Installation

The `@sentry/bun` package is already installed in the backend dependencies:

```json
{
  "dependencies": {
    "@sentry/bun": "^10.21.0"
  }
}
```

## Configuration

### Environment Variables

Add these to your `.env.local` file:

```bash
# Sentry Configuration (optional - for error tracking)
# Get your DSN from https://sentry.io/settings/projects/YOUR_PROJECT/keys/
SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
# Enable Sentry in development (optional)
SENTRY_ENABLED=false
```

### Sentry Configuration

The Sentry configuration is defined in `apps/backend/src/lib/sentry.ts`:

```typescript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  release: process.env.RELEASE_VERSION || "1.0.0",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  // ... additional configuration
});
```

## Features

### 1. Automatic Error Capture

Sentry automatically captures:

- ✅ Uncaught exceptions
- ✅ Unhandled promise rejections
- ✅ HTTP request errors (500+ status codes)
- ✅ tRPC procedure errors

### 2. Request Context

All errors include rich context:

- Request ID, method, URL
- User agent and headers
- Response time
- User information (when authenticated)

### 3. Performance Monitoring

- Transaction tracing with 10% sample rate in production
- Request performance metrics
- Database query performance (via custom instrumentation)

### 4. Environment-Based Behavior

- **Production**: Full error capture and performance monitoring
- **Development**: Disabled by default, can be enabled with `SENTRY_ENABLED=true`
- **Testing**: Completely disabled

## Integration Points

### 1. Application Startup

Sentry is initialized early in the application lifecycle:

```typescript
// apps/backend/src/index.ts
initializeContainer();
initializeSentry(); // ← Sentry initialized here
```

### 2. HTTP Error Handling

All HTTP errors are captured in the Elysia error middleware:

```typescript
.onError(({ error, request, set }) => {
  // Capture error in Sentry with request context
  captureException(error instanceof Error ? error : new Error(errorMessage), {
    requestId,
    method: request.method,
    url: request.url,
    duration: `${duration}ms`,
    userAgent: request.headers.get("user-agent"),
  });
  // ... rest of error handling
});
```

### 3. Graceful Shutdown

Sentry events are flushed during shutdown:

```typescript
const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, "🛑 Graceful shutdown initiated");

  logger.info({}, "Flushing Sentry events...");
  await flush(2000); // ← Flush pending events

  logger.info({}, "Closing HTTP server...");
  server.stop();

  logger.info({}, "Closing Sentry connection...");
  await close(2000); // ← Close Sentry connection

  process.exit(0);
};
```

### 4. Uncaught Exception Handling

Critical errors are captured before shutdown:

```typescript
process.on("uncaughtException", async (error) => {
  captureException(error, { type: "uncaughtException", fatal: true });
  await flush(2000); // Ensure error is sent
  process.exit(1);
});
```

## Usage Examples

### Manual Error Capture

```typescript
import { captureException, captureMessage } from "./lib/sentry";

// Capture an exception
try {
  // risky code
} catch (error) {
  captureException(error, { userId: "123", action: "import-holdings" });
}

// Capture a message
captureMessage("User exceeded rate limit", "warning", {
  userId: "123",
  endpoint: "/api/import",
  ip: "192.168.1.1",
});
```

### User Context

```typescript
import { setUser, setContext } from "./lib/sentry";

// Set user information
setUser({
  id: "user-123",
  email: "user@example.com",
});

// Add custom context
setContext("request", {
  method: "POST",
  url: "/api/holdings",
  userAgent: "Mozilla/5.0...",
});
```

### Breadcrumbs

```typescript
import { addBreadcrumb } from "./lib/sentry";

// Add debugging breadcrumbs
addBreadcrumb("Starting holdings import", "info", "import");
addBreadcrumb(`Processing ${holdings.length} holdings`, "info", "import");
```

## Error Filtering

Sentry ignores common network-related errors that don't indicate application bugs:

```typescript
ignoreErrors: [
  "ECONNRESET", // Connection reset by peer
  "EPIPE", // Broken pipe
  "ENOTFOUND", // DNS resolution failed
  "ECONNREFUSED", // Connection refused
  "TimeoutError", // Request timeout
  "AbortError", // Request aborted
];
```

## Monitoring Dashboard

Once configured, you'll see errors and performance data in your Sentry dashboard:

- **Issues**: Grouped error occurrences with stack traces
- **Performance**: Transaction traces and bottlenecks
- **Releases**: Error tracking by deployment version
- **Alerts**: Configurable notifications for critical errors

## Development Workflow

### Local Development

Sentry is disabled by default in development. To enable:

```bash
# In .env.local
SENTRY_ENABLED=true
SENTRY_DSN=your-development-dsn
```

### Production Deployment

Ensure these environment variables are set:

```bash
SENTRY_DSN=https://your-production-dsn@sentry.io/project-id
NODE_ENV=production
RELEASE_VERSION=1.2.3  # Your app version
```

### Testing

Sentry is automatically disabled during tests. No configuration needed.

## Troubleshooting

### Common Issues

1. **"Sentry not initialized" warnings**

   - Check that `SENTRY_DSN` is set
   - Verify the DSN format is correct

2. **Errors not appearing in dashboard**

   - Check network connectivity to Sentry
   - Verify DSN permissions
   - Check if errors are being filtered (see `ignoreErrors`)

3. **Performance impact**
   - Monitor `tracesSampleRate` (currently 10% in production)
   - Consider reducing sample rate if needed

### Debug Mode

Enable debug logging:

```bash
DEBUG=sentry:* npm run dev
```

## Security Considerations

- ✅ DSN is environment-specific (dev vs prod)
- ✅ No sensitive data is sent (filtered in `beforeSend`)
- ✅ HTTPS-only communication with Sentry
- ✅ Error events include request context but not request bodies
- ✅ User PII is handled according to your privacy policy

## Files Modified

- `apps/backend/package.json` - Added `@sentry/bun` dependency
- `apps/backend/.env.example` - Added Sentry configuration examples
- `apps/backend/src/lib/sentry.ts` - New Sentry configuration and utilities
- `apps/backend/src/index.ts` - Integrated Sentry into app lifecycle

## Next Steps

1. **Set up Sentry project** at https://sentry.io
2. **Configure environment variables** in production
3. **Set up alerts** for critical errors
4. **Monitor performance** metrics
5. **Consider frontend integration** (separate implementation needed)

## Migration Notes

- ✅ No breaking changes to existing code
- ✅ Optional configuration (works without Sentry)
- ✅ Backward compatible with existing error handling
- ✅ No database changes required
- ✅ No API changes required
