import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createComponentLogger } from '@scani/core/utils/logger';
import { RateLimiter } from '../../presentation/middleware/rate-limit';
import type { MCPAuthContext } from './auth';
import { authenticateMCPRequest } from './auth';
import { registerAccountsTools } from './tools/accounts';
import { isUnauthenticatedTool, registerAgentTools } from './tools/agent';
import { registerBatchOperationsTools } from './tools/batch-operations';
import { registerDashboardTools } from './tools/dashboard';
import { registerGroupsTools } from './tools/groups';
import { registerHoldingsTools } from './tools/holdings';
import { registerInstitutionsTools } from './tools/institutions';
import { registerIntegrationsTools } from './tools/integrations';
import { registerScreenshotsTools } from './tools/screenshots';
import { registerTokensTools } from './tools/tokens';
import { registerTypesTools } from './tools/types';
import { registerUsersTools } from './tools/users';
import { registerWalletTools } from './tools/wallet';
import { checkX402Payment, createX402Response } from './x402-middleware';

const logger = createComponentLogger('mcp:server');

// MCP-specific rate limiter: 60 requests/minute per API key with burst of 90
// Uses API key as the rate limit key for per-user limiting
const mcpRateLimiter = new RateLimiter({
  windowMs: 60_000,
  max: 60,
  burst: 90,
  maxBuckets: 5000,
  // Key by API key (from Authorization header) for per-user rate limiting
  key: (req: Request) => {
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7); // Use the API key as the bucket key
    }
    // Fallback to IP if no auth header
    return getClientIp(req);
  },
});

// Aggressive rate limiter for unauthenticated registration: 5 per hour per IP
const registrationRateLimiter = new RateLimiter({
  windowMs: 3600_000, // 1 hour
  max: 5, // 5 registrations per hour
  burst: 5, // No burst allowed
  maxBuckets: 10000,
  // Key by IP only for registration (no auth available)
  key: (req: Request) => getClientIp(req),
});

/**
 * Get client IP from request headers
 */
function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

// AsyncLocalStorage for request-scoped auth context (thread-safe)
const authStorage = new AsyncLocalStorage<MCPAuthContext>();

// Create the MCP server instance
export const mcpServer = new McpServer({
  name: 'scani-api',
  version: '1.0.0',
});

// Transport instance for stateless HTTP mode (Bun-compatible)
let transport: WebStandardStreamableHTTPServerTransport | null = null;

/**
 * Get the current authenticated user ID from AsyncLocalStorage
 * Must be called within a tool handler after authentication
 * Thread-safe: uses AsyncLocalStorage instead of global mutable state
 */
export function getCurrentUserId(): string {
  const context = authStorage.getStore();
  if (!context || !context.isAuthenticated) {
    throw new Error('No authenticated user context');
  }
  return context.userId;
}

/**
 * Run a callback within an auth context (thread-safe)
 * This replaces the old setAuthContext/clearAuthContext pattern
 */
export function runWithAuthContext<T>(
  context: MCPAuthContext,
  callback: () => T | Promise<T>
): T | Promise<T> {
  return authStorage.run(context, callback);
}

/**
 * @deprecated Use runWithAuthContext instead - kept for backward compatibility
 */
export function setAuthContext(_context: MCPAuthContext) {
  // No-op: context is now managed by AsyncLocalStorage via runWithAuthContext
}

/**
 * @deprecated Context is now managed by AsyncLocalStorage
 */
export function clearAuthContext() {
  // No-op: AsyncLocalStorage handles cleanup automatically
}

/**
 * Register all MCP tools
 * Tools are organized by domain/router
 */
export function registerAllTools() {
  logger.info('Registering MCP tools');

  // Register tools from each domain
  registerAgentTools(mcpServer); // Agent registration (includes unauthenticated tool)
  registerUsersTools(mcpServer);
  registerDashboardTools(mcpServer);
  registerTokensTools(mcpServer);
  registerAccountsTools(mcpServer);
  registerHoldingsTools(mcpServer);
  registerInstitutionsTools(mcpServer);
  registerGroupsTools(mcpServer);
  registerWalletTools(mcpServer);
  registerBatchOperationsTools(mcpServer);
  registerTypesTools(mcpServer);
  registerScreenshotsTools(mcpServer);
  registerIntegrationsTools(mcpServer);

  logger.info('MCP tools registered successfully');
}

/**
 * Initialize the MCP transport and connect to the server
 * Uses WebStandardStreamableHTTPServerTransport for Bun compatibility
 */
export async function initializeMcpTransport(): Promise<void> {
  if (transport) {
    logger.warn('MCP transport already initialized');
    return;
  }

  // Create stateless transport (no session management needed for API key auth)
  transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode - each request is independent
    sessionIdGenerator: undefined,
    // Enable JSON response mode (simpler for tool calls)
    enableJsonResponse: true,
  });

  // Connect the transport to the MCP server
  await mcpServer.connect(transport);
  logger.info('MCP transport initialized and connected');
}

/**
 * Parsed JSON-RPC request body
 */
interface ParsedMcpRequest {
  id: string | number | null;
  method: string | null;
  toolName: string | null;
  rawBody: string;
}

/**
 * Parse the JSON-RPC request body
 * If preBody is provided (from Elysia), use it directly
 * Otherwise, read from request (may fail if already consumed)
 */
function parseMcpRequestBody(preBody?: Record<string, unknown>): ParsedMcpRequest {
  if (!preBody) {
    return {
      id: null,
      method: null,
      toolName: null,
      rawBody: '',
    };
  }

  const body = preBody as {
    id?: string | number | null;
    method?: string;
    params?: { name?: string };
  };

  return {
    id: typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null,
    method: body.method ?? null,
    toolName: body.method === 'tools/call' && body.params?.name ? body.params.name : null,
    rawBody: JSON.stringify(preBody),
  };
}

/**
 * Create a fresh Request with the same body and headers
 * This is needed because Request bodies can only be read once
 */
function createFreshRequest(original: Request, rawBody: string): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: rawBody,
  });
}

/**
 * Create a JSON-RPC error response
 */
function createJsonRpcError(
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
  retryAfter?: number
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (retryAfter) {
    headers['Retry-After'] = String(retryAfter);
  }

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code,
        message,
      },
      id,
    }),
    { status, headers }
  );
}

/**
 * Handle an incoming MCP request
 * Handles both authenticated and unauthenticated (registration) requests
 * Applies appropriate rate limiting based on request type
 *
 * @param request - The original Request object
 * @param preBody - Pre-parsed body from Elysia (since body stream may be consumed)
 */
export async function handleMcpRequest(
  request: Request,
  preBody?: Record<string, unknown>
): Promise<Response> {
  // Ensure transport is initialized
  if (!transport) {
    await initializeMcpTransport();
  }

  // Parse request body - use preBody if available (Elysia already parsed it)
  const parsed = parseMcpRequestBody(preBody);
  const { id: requestId, toolName } = parsed;

  logger.debug({ toolName, method: parsed.method, requestId }, 'Parsed MCP request');

  // Create fresh request for transport (body has been consumed)
  const freshRequest = createFreshRequest(request, parsed.rawBody);

  // Check if this is an unauthenticated tool (like agent_register)
  const isUnauthenticated = toolName && isUnauthenticatedTool(toolName);

  if (isUnauthenticated) {
    // Apply aggressive rate limiting for registration (5 per hour per IP)
    const registrationRateResult = registrationRateLimiter.tryConsume(request);
    if (!registrationRateResult.ok) {
      logger.warn(
        {
          retryAfterSec: registrationRateResult.retryAfterSec,
          ip: getClientIp(request),
        },
        '⚠️ Registration rate limit exceeded'
      );
      return createJsonRpcError(
        429,
        -32005,
        'Registration rate limit exceeded. Maximum 5 registrations per hour per IP.',
        requestId,
        registrationRateResult.retryAfterSec
      );
    }

    logger.info(
      { toolName, ip: getClientIp(request) },
      '🤖 Processing unauthenticated MCP request'
    );

    // Process without authentication - no auth context needed
    try {
      const response = await transport!.handleRequest(freshRequest);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage }, '❌ Unauthenticated MCP request failed');
      return createJsonRpcError(500, -32603, errorMessage, requestId);
    }
  }

  // For authenticated requests, apply standard rate limiting
  const rateLimitResult = mcpRateLimiter.tryConsume(request);
  if (!rateLimitResult.ok) {
    logger.warn({ retryAfterSec: rateLimitResult.retryAfterSec }, '⚠️ MCP rate limit exceeded');
    return createJsonRpcError(
      429,
      -32005, // Custom code for rate limiting
      'Rate limit exceeded. Please retry later.',
      requestId,
      rateLimitResult.retryAfterSec
    );
  }

  try {
    // Authenticate the request
    const authContext = await authenticateMCPRequest(request);

    logger.debug(
      { userId: authContext.userId, method: request.method },
      '🤖 MCP request authenticated'
    );

    // Check x402 payment for paid tools
    if (toolName) {
      const paymentCheck = await checkX402Payment(toolName, request, authContext.userId);
      if (paymentCheck.required) {
        logger.info(
          {
            toolName,
            userId: authContext.userId,
            amount: paymentCheck.requirements.accepts[0]?.maxAmountRequired,
          },
          '💰 x402 payment required'
        );
        return createX402Response(paymentCheck.requirements, requestId);
      }
    }

    // Process the request within the auth context
    // AsyncLocalStorage ensures each concurrent request has its own isolated context
    const response = await runWithAuthContext(authContext, async () => {
      return transport!.handleRequest(freshRequest);
    });

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage }, '❌ MCP request failed');

    // Determine appropriate error code and status
    const isAuthError = errorMessage.includes('Authentication') || errorMessage.includes('API key');
    const status = isAuthError ? 401 : 500;
    const code = isAuthError ? -32001 : -32603;

    return createJsonRpcError(status, code, errorMessage, requestId);
  }
}

/**
 * Authenticate a request and return the auth context
 */
export async function authenticateRequest(request: Request): Promise<MCPAuthContext> {
  return await authenticateMCPRequest(request);
}
