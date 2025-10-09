# WebSocket Port Fix - October 9, 2025

## Problem

The WebSocket server was configured to run on a **separate port** (PORT + 1) from the HTTP server:

- HTTP server: Port 3001 (or PORT from env)
- WebSocket server: Port 3002 (PORT + 1)

This worked fine in local development but **failed in production on Render** because:

- Render web services only expose **one port** per service
- The WebSocket port (3002) was not accessible from the internet
- WebSocket connections would fail silently

## Solution

Changed the WebSocket server to use **WebSocket upgrade requests** on the same HTTP server port:

### Backend Changes (`apps/backend/src/index.ts`)

**Before:**

```typescript
const wss = new WebSocketServer({
  port: PORT + 1, // Separate port!
  host: HOST,
  maxPayload: 256 * 1024,
});
```

**After:**

```typescript
// Create WebSocket server in noServer mode
const wss = new WebSocketServer({
  noServer: true, // Don't create separate HTTP server
  maxPayload: 256 * 1024,
});

// Start HTTP server
const server = app.listen(PORT, () => {
  logger.info({
    httpUrl: `http://${HOST}:${PORT}`,
    wsUrl: `ws://${HOST}:${PORT}`,
  });
});

// Attach WebSocket upgrade handler to HTTP server
const httpServer = (server as unknown as { server: import("http").Server })
  .server;
httpServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
```

### Frontend Changes (`apps/frontend/src/hooks/useRealtimeEntitySync.ts`)

**Before:**

```typescript
const port = parsed.port
  ? Number(parsed.port)
  : parsed.protocol === "https:"
  ? 443
  : 80;
parsed.port = String(port + 1); // Add 1 to port!
```

**After:**

```typescript
// Use the same port as the API server, just change protocol
parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
// No port change needed!
```

## How WebSocket Upgrade Works

1. Client connects to `wss://api.scani.xyz` (same port as HTTP API)
2. Client sends HTTP upgrade request with `Upgrade: websocket` header
3. HTTP server receives upgrade event, passes to WebSocket server
4. WebSocket server handles the upgrade and establishes WebSocket connection
5. Connection continues as WebSocket on the same TCP socket

This is the **standard WebSocket protocol** - the HTTP server and WebSocket server share the same port!

## Production URLs

- **HTTP API**: `https://api.scani.xyz` → Port 443
- **WebSocket**: `wss://api.scani.xyz` → **Same port 443!**
- **Frontend**: `https://app.scani.xyz` → Connects to `wss://api.scani.xyz`

## Local Development

- **HTTP API**: `http://localhost:3001`
- **WebSocket**: `ws://localhost:3001` (same port)

## Testing

To test WebSocket connections:

```bash
# In production
wscat -c "wss://api.scani.xyz?token=YOUR_JWT_TOKEN"

# Local development
wscat -c "ws://localhost:3001?token=YOUR_JWT_TOKEN"
```

## Benefits

✅ **Single Port**: Only need to expose one port in production  
✅ **Standard Protocol**: Uses standard WebSocket upgrade mechanism  
✅ **Simpler Deployment**: No need to configure multiple ports  
✅ **Better Compatibility**: Works with all reverse proxies and load balancers  
✅ **Easier Firewall Rules**: Only one port to allow through firewalls

## Deployment Notes

After this fix:

1. **No Render configuration changes needed** - same port already exposed
2. **Environment variables unchanged** - no new config needed
3. **Automatic SSL**: WebSocket connections use same SSL cert as HTTPS
4. **Works immediately** - deploy and test

## Related Files

- `/apps/backend/src/index.ts` - WebSocket server setup
- `/apps/frontend/src/hooks/useRealtimeEntitySync.ts` - WebSocket client connection
- `/apps/frontend/src/hooks/useWebSocket.ts` - WebSocket hook implementation

## Commit

Commit hash: `886a289`  
Date: October 9, 2025
