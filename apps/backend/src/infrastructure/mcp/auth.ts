import { ApiKeyService } from '@scani/core/services/ApiKeyService';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';

const logger = createComponentLogger('mcp:auth');
const apiKeyService = Container.get(ApiKeyService);

export interface MCPAuthContext {
  userId: string;
  isAuthenticated: boolean;
}

/**
 * Extract and validate API key from request headers
 * Returns the authenticated user ID if valid, throws error otherwise
 */
export async function authenticateMCPRequest(request: Request): Promise<MCPAuthContext> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    logger.warn('No authorization header present in MCP request');
    throw new Error('Authentication required');
  }

  if (!authHeader.startsWith('Bearer ')) {
    logger.warn('Authorization header does not start with Bearer');
    throw new Error('Invalid authorization header format');
  }

  const apiKey = authHeader.substring(7); // Remove "Bearer " prefix

  // Validate API key format (should start with sk_live_)
  if (!apiKey.startsWith('sk_live_')) {
    logger.warn('Invalid API key format');
    throw new Error('Invalid API key format');
  }

  try {
    // Validate the API key and get the associated user
    const validatedKey = await apiKeyService.validateApiKey(apiKey);

    logger.info({ userId: validatedKey.userId }, 'MCP request authenticated successfully');

    return {
      userId: validatedKey.userId,
      isAuthenticated: true,
    };
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'API key validation failed'
    );
    throw new Error('Invalid or expired API key');
  }
}
