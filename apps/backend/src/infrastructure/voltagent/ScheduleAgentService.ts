import { openai } from '@ai-sdk/openai';
import { Agent, Memory } from '@voltagent/core';
import { PostgreSQLMemoryAdapter } from '@voltagent/postgres';

/**
 * VoltAgent service for schedule step configuration
 * Uses PostgreSQL memory adapter for conversation persistence
 */
export class ScheduleAgentService {
  private agent: Agent;
  private memoryAdapter: PostgreSQLMemoryAdapter;
  private memory: Memory;

  constructor() {
    // Get DATABASE_URL from environment
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required for VoltAgent memory');
    }

    // Initialize PostgreSQL memory adapter
    this.memoryAdapter = new PostgreSQLMemoryAdapter({
      connection: DATABASE_URL,
      tablePrefix: 'voltagent_memory',
      debug: process.env.NODE_ENV === 'development',
    });

    // Wrap adapter in Memory instance
    this.memory = new Memory({
      storage: this.memoryAdapter,
    });

    // Initialize VoltAgent agent with AI SDK model
    this.agent = new Agent({
      name: 'schedule-configurator',
      instructions:
        'You are an AI assistant that helps users configure schedule steps for their financial schedules. You can help create inflow, outflow, transfer, and conversion steps based on natural language input.',
      model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
      memory: this.memory,
      // Tools will be added here for schedule step manipulation
    });
  }

  /**
   * Send a message to the agent and get a response
   */
  async sendMessage(params: {
    userId: string;
    scheduleId: string;
    message: string;
    conversationId?: string;
  }): Promise<{
    id: string;
    message: string;
    timestamp: string;
    conversationId: string;
  }> {
    const { userId, message, conversationId } = params;

    // Generate conversation ID if not provided
    const actualConversationId = conversationId || crypto.randomUUID();

    // Call the agent with the user message
    // The agent's memory will automatically store the conversation
    const response = await this.agent.generateText(message, {
      userId,
      conversationId: actualConversationId,
    });

    return {
      id: crypto.randomUUID(),
      message: response.text,
      timestamp: new Date().toISOString(),
      conversationId: actualConversationId,
    };
  }

  /**
   * Get conversation history
   */
  async getConversation(params: { userId: string; conversationId: string }): Promise<
    Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
    }>
  > {
    const { userId, conversationId } = params;

    // Retrieve messages from memory using the storage adapter
    const messages = await this.memoryAdapter.getMessages(userId, conversationId);

    // Transform to expected format
    // UIMessage structure from ai package has role, content as array of parts
    // biome-ignore lint/suspicious/noExplicitAny: UIMessage type is complex and varies
    return messages.map((msg: any) => {
      let textContent = '';
      if (Array.isArray(msg.content)) {
        textContent = msg.content
          // biome-ignore lint/suspicious/noExplicitAny: Content parts can be strings or objects
          .map((part: any) => {
            if (typeof part === 'string') return part;
            if (part.type === 'text') return part.text || '';
            return '';
          })
          .join(' ');
      } else if (typeof msg.content === 'string') {
        textContent = msg.content;
      }

      return {
        id: msg.id || crypto.randomUUID(),
        role: msg.role as 'user' | 'assistant',
        content: textContent,
        timestamp: msg.experimental_attachments?.createdAt
          ? new Date(msg.experimental_attachments.createdAt).toISOString()
          : new Date().toISOString(),
      };
    });
  }

  /**
   * Clear conversation history
   */
  async clearConversation(params: { userId: string; conversationId: string }): Promise<boolean> {
    const { userId, conversationId } = params;

    try {
      // Clear messages from memory using the storage adapter
      await this.memoryAdapter.clearMessages(userId, conversationId);
      return true;
    } catch (error) {
      console.error('Error clearing conversation:', error);
      return false;
    }
  }

  /**
   * Initialize database tables for VoltAgent memory
   * Should be called on application startup
   * The PostgreSQL memory adapter will automatically create tables on first use
   */
  async initializeMemoryTables(): Promise<void> {
    try {
      // Tables are automatically created by the adapter on first use
      console.log('✅ VoltAgent PostgreSQL memory adapter ready');
    } catch (error) {
      console.error('❌ Error initializing VoltAgent memory:', error);
      throw error;
    }
  }
}
