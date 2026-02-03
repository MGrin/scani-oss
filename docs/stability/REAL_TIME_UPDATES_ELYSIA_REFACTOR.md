# Refactor: Real-Time Updates Service for Elysia WebSocket

**Date**: 2025-10-09  
**Status**: ✅ Completed  
**Priority**: 🔴 Critical  

---

## Problem

The `realTimeUpdatesService` was designed for Node.js `ws` package which has a different API than Elysia's WebSocket implementation. When trying to use it with Elysia:

```
❌ ERROR: ws.on is not a function
```

The service was trying to call `.on()` methods on Elysia's WebSocket objects, which don't exist. Elysia uses a different lifecycle model with hooks (`open`, `message`, `close`) and a pub/sub pattern instead of managing WebSocket instances directly.

---

## Solution

Completely refactored `realTimeUpdatesService` to work with Elysia's WebSocket architecture:

### Architecture Changes

**Before** (Node.js ws):
- Service created and managed `WebSocketServer` instance
- Attached to HTTP server via `upgrade` event
- Managed individual WebSocket connections
- Sent messages directly to WebSocket instances
- Used `.on('message')`, `.on('close')` event handlers

**After** (Elysia native):
- Service acts as a coordination layer
- Elysia manages WebSocket lifecycle via hooks
- Service tracks connection metadata only
- Uses Elysia's pub/sub for broadcasting
- Integrates with Elysia's `open`, `message`, `close` handlers

---

## Key Changes

### 1. Service Architecture

**Removed**:
- `WebSocketServer` instance management
- Direct WebSocket connection handling
- `.on()` event handler setup
- Direct `.send()` message delivery

**Added**:
- `setElysiaApp()` - Store Elysia app for pub/sub access
- Elysia pub/sub broadcasting via `app.server.publish()`
- Topic-based messaging: `user:${userId}`
- Lightweight connection metadata tracking

### 2. WebSocket Lifecycle Integration

```typescript
// Elysia WebSocket Handler (index.ts)
app.ws('/', {
  open: async (ws) => {
    // Authenticate user
    const authenticatedUserId = await authenticateToken(token);
    
    // Register with service (metadata only)
    realTimeUpdatesService.registerConnection({
      userId: authenticatedUserId,
      connectionId,
    });
    
    // Subscribe to user's topic for pub/sub
    ws.subscribe(`user:${authenticatedUserId}`);
    
    // Send confirmation
    ws.send(JSON.stringify({ type: 'connected', ... }));
  },
  
  message: (ws, message) => {
    // Forward to service for handling
    realTimeUpdatesService.handleMessage(ws.data.connectionId, message);
  },
  
  close: (ws) => {
    // Notify service of disconnection
    realTimeUpdatesService.handleDisconnection(ws.data.connectionId);
  },
});
```

### 3. Broadcasting with Pub/Sub

**Before** (Direct send):
```typescript
broadcast(event: RealTimeEvent) {
  const userConnections = this.userConnections.get(event.userId);
  for (const connectionId of userConnections) {
    const client = this.clients.get(connectionId);
    client.websocket.send(JSON.stringify(message)); // ❌ Direct send
  }
}
```

**After** (Pub/sub):
```typescript
broadcast(event: RealTimeEvent) {
  const topic = `user:${event.userId}`;
  
  // Publish to all subscribers of this user's topic
  this.elysiaApp.server.publish(topic, JSON.stringify(message)); // ✅ Pub/sub
}
```

---

## Benefits

### ✅ Pros

1. **Native Integration**: Works seamlessly with Elysia/Bun
2. **Better Performance**: Pub/sub is more efficient than iterating connections
3. **Simpler Code**: Less connection management overhead
4. **More Reliable**: Elysia handles connection lifecycle
5. **Scalable**: Pub/sub pattern scales better than direct sends

### 🎯 How It Works

1. **Connection Registration**:
   - User connects via WebSocket with auth token
   - Service stores connection metadata (userId, connectionId, subscriptions)
   - Connection subscribes to `user:${userId}` topic

2. **Message Handling**:
   - Client sends message (ping, subscribe, unsubscribe)
   - Service processes message
   - Responses published to user's topic

3. **Broadcasting**:
   - Backend creates/updates entity (e.g., holding)
   - Calls `emitEntityChange()` helper
   - Service publishes to `user:${userId}` topic
   - All user's connections receive the update

4. **Disconnection**:
   - WebSocket closes
   - Service cleans up metadata
   - User automatically unsubscribed by Elysia

---

## Files Modified

### Backend
1. **`apps/backend/src/services/real-time-updates.ts`** - Major refactor
   - Removed Node.js `ws` imports
   - Removed `WebSocketServer` management
   - Added `setElysiaApp()` method
   - Updated `broadcast()` to use pub/sub
   - Made `handleMessage()` and `handleDisconnection()` public
   - Replaced `sendToClient()` with pub/sub
   - Updated `registerConnection()` to not require WebSocket instance

2. **`apps/backend/src/index.ts`** - Integration
   - Re-added `realTimeUpdatesService` import
   - Updated WebSocket `open` handler to register connections
   - Added `message` handler forwarding
   - Added `close` handler cleanup
   - Initialize service with Elysia app after server starts

---

## Migration Guide

### Topic Naming Convention

All connections for a user subscribe to: `user:${userId}`

This single topic receives:
- Entity change notifications
- Subscription updates
- Pong responses
- All real-time events

### Broadcasting Pattern

```typescript
// Anywhere in the backend (routers, services, etc.)
import { emitEntityChange } from './services/real-time-updates';

// After creating/updating an entity
await db.insert(holdings).values(newHolding);

// Emit change event
emitEntityChange({
  type: 'entity_changed',
  entityType: 'holding',
  entityId: newHolding.id,
  operationType: 'create',
  userId: currentUser.id,
  data: { /* optional data */ },
  metadata: {
    relatedEntities: [
      { type: 'account', id: newHolding.accountId },
      { type: 'token', id: newHolding.tokenId },
    ],
  },
});
```

---

## Testing

### Manual Test

1. **Start Application**:
   ```bash
   cd /Users/mgrin/Projects/mgrin/scani
   bun dev
   ```

2. **Check Logs**:
   ```
   ✅ Expected:
   🔌 WebSocket endpoint configured (using Elysia native WebSocket)
   🎉 Scani Backend Server started successfully
   Elysia app instance registered with realTimeUpdatesService
   Real-time updates service initialized (Elysia mode)
   
   ❌ No errors about ws.on or WebSocketServer
   ```

3. **Test WebSocket Connection**:
   - Open frontend in browser
   - Login
   - Check browser console for:
     ```
     WebSocket connection established
     Received: {"type":"connected","connectionId":"...","subscriptions":[...]}"
     ```

4. **Test Real-Time Updates**:
   - Create a new holding
   - Watch for WebSocket message in console
   - Should see `entity_changed` event immediately
   - Frontend cache should invalidate automatically

---

## Monitoring

### Metrics to Track

- **WebSocket Connection Success Rate**: Should be ~100%
- **Message Delivery Success Rate**: Should be ~100%
- **Broadcasting Latency**: Should be <100ms
- **Connection Count**: Track active connections
- **Message Volume**: Monitor pub/sub traffic

### Logging

Service logs key events:
- Connection registration
- Message handling (subscribe, unsubscribe, ping)
- Broadcasting (entity changes)
- Disconnections
- Errors

---

## Backwards Compatibility

### API Compatibility

The public API remains the same:
- `emitEntityChange()` - Still works
- `emitBulkEntityChanges()` - Still works
- `withRealTimeUpdates()` - Still works

### Frontend Compatibility

No changes needed! Frontend still:
- Connects to `ws://HOST:PORT/?token=...`
- Receives same message format
- Handles `entity_changed` events identically

---

## Future Improvements

### Short Term
- [ ] Add connection timeout handling
- [ ] Implement message queue for offline users
- [ ] Add metrics/monitoring dashboard

### Long Term
- [ ] Support for multi-instance deployment (Redis pub/sub)
- [ ] Message persistence for guaranteed delivery
- [ ] Advanced subscription filtering
- [ ] Rate limiting per connection

---

## Troubleshooting

### Issue: "Elysia app not set, cannot broadcast"

**Cause**: `setElysiaApp()` not called before broadcasting

**Fix**: Ensure initialization in index.ts:
```typescript
const server = app.listen(PORT, () => { ... });
realTimeUpdatesService.setElysiaApp(app);
realTimeUpdatesService.initialize();
```

### Issue: Messages not received

**Cause**: User not subscribed to topic

**Fix**: Verify subscription in WebSocket `open` handler:
```typescript
ws.subscribe(`user:${authenticatedUserId}`);
```

### Issue: Duplicate messages

**Cause**: Multiple connections for same user

**Expected**: This is normal! Each browser tab/window creates a separate connection, all subscribed to same topic.

---

## Related Documentation

- **Elysia WebSocket Docs**: https://elysiajs.com/plugins/websocket.html
- **Bun WebSocket API**: https://bun.sh/docs/api/websockets
- **Previous Fix**: `docs/fixes/WEBSOCKET_ELYSIA_MIGRATION.md`
- **Token Cache Fix**: `docs/fixes/TOKEN_CACHE_REFRESH_FIX.md`

---

**Refactor Completed**: 2025-10-09  
**Testing Status**: ✅ Passes compilation and startup  
**Ready for**: Manual QA and production deployment  

