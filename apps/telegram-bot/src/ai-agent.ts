import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { ToolExecutor } from './tool-executor';
import { tools } from './tools';

export interface AIAgentConfig {
  openAIApiKey: string;
  model?: string;
}

export interface ConversationContext {
  userId: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export class AIAgent {
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK model type is complex and changes between versions
  private model: any;

  constructor(config: AIAgentConfig) {
    // Initialize OpenAI provider
    this.model = openai(config.model || 'gpt-4o-mini');
  }

  async chat(message: string, context: ConversationContext): Promise<string> {
    try {
      // Create tool executor with user context
      const toolExecutor = new ToolExecutor({ userId: context.userId });

      // Convert our tool definitions to AI SDK format
      const aiTools = this.convertToolsToAISDK(toolExecutor);

      // Generate response with tools
      const result = await generateText({
        model: this.model,
        system: this.getSystemPrompt(),
        messages: [
          ...context.conversationHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: 'user',
            content: message,
          },
        ],
        tools: aiTools,
        maxSteps: 5, // Allow multiple tool calls
      });

      return result.text;
    } catch (error) {
      console.error('Error in AI agent chat:', error);
      throw error;
    }
  }

  private getSystemPrompt(): string {
    return `You are a helpful financial assistant for Scani, a personal finance management application.

Your role is to help users:
- View and understand their portfolio
- Manage their accounts and holdings
- Search for investment information
- Add or update financial data
- Get insights about their investments

Guidelines:
- Be friendly, concise, and helpful
- When showing financial data, format numbers clearly with currency symbols
- Always confirm before performing destructive operations (delete account, delete holding)
- If you need to use a tool, explain what you're doing
- Provide context and explanations for financial information
- If user asks about something you can't help with, politely explain the limitation

Available capabilities:
- View portfolio overview and dashboard
- List and manage accounts
- List and manage holdings (stocks, crypto, etc.)
- Search for tokens and get prices
- Import multiple holdings at once
- List available institutions and account types`;
  }

  // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool executor parameters are dynamically typed
  private convertToolsToAISDK(toolExecutor: ToolExecutor): Record<string, any> {
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool format requires any type
    const aiTools: Record<string, any> = {};

    for (const [toolName, toolDef] of Object.entries(tools)) {
      aiTools[toolName] = tool({
        description: toolDef.description,
        parameters: toolDef.parameters,
        // biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamically typed based on tool definition
        // biome-ignore lint/suspicious/noExplicitAny: Tool name cast needed for type safety
        execute: async (params: any) => {
          return await toolExecutor.executeTool(toolName as any, params);
        },
      });
    }

    return aiTools;
  }
}
