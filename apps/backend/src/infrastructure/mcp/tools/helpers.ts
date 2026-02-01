import { ZodError } from 'zod';

/**
 * Helper type for MCP tool content response
 * Uses index signature to satisfy MCP SDK's expected return type
 */
export interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

/**
 * Check if we're in production environment
 */
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Creates a successful MCP tool response
 */
export function createSuccessResponse(data: unknown): McpToolResponse {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Creates an error MCP tool response
 * In production, stack traces are omitted for security
 */
export function createErrorResponse(error: unknown): McpToolResponse {
  let errorMessage: string;
  let errorDetails: string | undefined;

  if (error instanceof ZodError) {
    errorMessage = 'Validation error: Invalid parameters';
    errorDetails = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
  } else if (error instanceof Error) {
    errorMessage = error.message;
    // Only include stack traces in non-production environments
    errorDetails = isProduction ? undefined : error.stack;
  } else {
    errorMessage = 'Unknown error occurred';
    errorDetails = isProduction ? undefined : String(error);
  }

  const response: { error: string; details?: string } = {
    error: errorMessage,
  };

  // Only include details if present
  if (errorDetails) {
    response.details = errorDetails;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
