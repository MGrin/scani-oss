import { openai } from '@ai-sdk/openai';
import { HoldingRepository } from '@scani/core/repositories';
import { ScheduleStepTypeRepository } from '@scani/core/repositories/EnumRepositories';
import { ScheduleService } from '@scani/core/services';
import { Agent, Memory } from '@voltagent/core';
import { PostgreSQLMemoryAdapter } from '@voltagent/postgres';
import { tool } from 'ai';
import { Container } from 'typedi';
import { z } from 'zod';

/**
 * VoltAgent service for schedule step configuration
 * Uses PostgreSQL memory adapter for conversation persistence
 */
export class ScheduleAgentService {
  private agent: Agent;
  private memoryAdapter: PostgreSQLMemoryAdapter;
  private memory: Memory;
  private scheduleService = Container.get(ScheduleService);
  private holdingRepository = Container.get(HoldingRepository);
  private scheduleStepTypeRepository = Container.get(ScheduleStepTypeRepository);

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

    // Initialize VoltAgent agent with AI SDK model and tools
    this.agent = new Agent({
      name: 'schedule-configurator',
      instructions: this.getSystemInstructions(),
      model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
      memory: this.memory,
      tools: Object.values(this.createTools()),
    });
  }

  /**
   * Get comprehensive system instructions following industry best practices
   */
  private getSystemInstructions(): string {
    return `You are an AI assistant specialized in configuring financial schedule steps for the Scani personal finance application.

## Your Role and Purpose
You help users create, modify, and manage schedule steps that define financial workflows. A schedule consists of ordered steps that execute sequentially to process financial transactions.

## Available Step Types
1. **Inflow**: Money coming in from an external source
   - Parameters: from (counterparty name), toHoldingId (destination), amount
   - Example: "Salary deposit to checking account"

2. **Outflow**: Money going out to an external destination
   - Parameters: fromHoldingId (source), to (counterparty name), amount
   - Example: "Rent payment from checking account"

3. **Transfer**: Moving money between holdings (same currency)
   - Parameters: fromHoldingId, toHoldingId, amount OR percent
   - Example: "Transfer 30% to savings account"

4. **Conversion**: Converting between different currencies or assets
   - Parameters: fromHoldingId, toHoldingId, amount OR percent
   - Example: "Convert 1000 USD to EUR"

## Tools Available
You have access to the following tools:
- listSteps: View all current steps in a schedule
- createStep: Create a new schedule step
- updateStep: Modify an existing step
- deleteStep: Remove a step from the schedule
- validateSteps: Check if the schedule configuration is valid
- getHoldings: List user's holdings (accounts/wallets) for reference
- getScheduleStepTypes: Get available step type IDs

## Guidelines and Best Practices
1. **Always list holdings first** when creating steps involving holdings
2. **Validate step order** - steps execute sequentially, order matters
3. **Verify step types** using getScheduleStepTypes before creating steps
4. **Use precise amounts** - financial calculations require exactness
5. **Confirm before deleting** - deletions are permanent
6. **Check validation** after major changes

## Limitations
- You can only modify the schedule you're currently working with
- You cannot access other users' data
- You cannot execute schedules, only configure them
- Amounts must be positive decimal numbers
- Percentages must be between 0-100

## Response Style
- Be concise and clear
- Confirm actions taken
- Provide specific details (IDs, amounts, names)
- Suggest next steps when appropriate
- Ask for clarification if user intent is ambiguous

When users make requests, use the appropriate tools to fulfill them and provide clear feedback about what was accomplished.`;
  }

  /**
   * Create tools for the agent using AI SDK's tool function
   */
  private createTools() {
    const scheduleService = this.scheduleService;
    const holdingRepository = this.holdingRepository;
    const scheduleStepTypeRepository = this.scheduleStepTypeRepository;

    return {
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool type compatibility with VoltAgent
      listSteps: tool({
        description: 'List all current steps in the schedule with their details and order',
        parameters: z.object({
          scheduleId: z.string().uuid().describe('The schedule ID to list steps for'),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue
        execute: async (args: any, options: any) => {
          const { scheduleId } = args;
          const userId = options.context?.userId as string;
          const steps = await scheduleService.getScheduleSteps(userId, scheduleId);
          return {
            success: true,
            steps: steps.map((s) => ({
              id: s.id,
              typeId: s.typeId,
              stepOrder: s.stepOrder,
              data: s.data,
            })),
          };
        },
      }) as any,

      createStep: tool({
        description: 'Create a new schedule step (inflow, outflow, transfer, or conversion)',
        parameters: z.object({
          scheduleId: z.string().uuid().describe('The schedule ID to add the step to'),
          typeId: z.string().uuid().describe('The step type ID (from getScheduleStepTypes)'),
          stepOrder: z
            .number()
            .default(0)
            .describe('Order of execution (0 = first, higher = later)'),
          data: z
            .record(z.any())
            .describe(
              'Step data object - structure depends on type (inflow: {from, toHoldingId, amount}, outflow: {fromHoldingId, to, amount}, transfer/conversion: {fromHoldingId, toHoldingId, amount OR percent})'
            ),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (args: any, options: any) => {
          const { scheduleId, typeId, stepOrder, data } = args;
          const userId = options.context?.userId as string;
          const result = await scheduleService.createScheduleStep(
            {
              scheduleId,
              typeId,
              stepOrder,
              data: data as Parameters<typeof scheduleService.createScheduleStep>[0]['data'],
            },
            userId
          );
          return {
            success: true,
            stepId: result.id,
            message: `Created step with order ${stepOrder}`,
          };
        },
      }) as any,

      updateStep: tool({
        description: 'Update an existing schedule step',
        parameters: z.object({
          scheduleId: z.string().uuid().describe('The schedule ID containing the step'),
          stepId: z.string().uuid().describe('The step ID to update'),
          typeId: z.string().uuid().optional().describe('New step type ID (optional)'),
          stepOrder: z.number().optional().describe('New execution order (optional)'),
          data: z.record(z.any()).optional().describe('Updated step data object (optional)'),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (args: any, options: any) => {
          const { scheduleId, stepId, typeId, stepOrder, data } = args;
          const userId = options.context?.userId as string;
          const updateData: Parameters<typeof scheduleService.updateScheduleStep>[1] = {};
          if (typeId) updateData.typeId = typeId;
          if (stepOrder !== undefined) updateData.stepOrder = stepOrder;
          if (data) {
            updateData.data = data as Parameters<
              typeof scheduleService.updateScheduleStep
            >[1]['data'];
          }

          await scheduleService.updateScheduleStep(stepId, updateData, userId, scheduleId);
          return {
            success: true,
            message: 'Step updated successfully',
          };
        },
      }) as any,

      deleteStep: tool({
        description: 'Delete a schedule step',
        parameters: z.object({
          scheduleId: z.string().uuid().describe('The schedule ID containing the step'),
          stepId: z.string().uuid().describe('The step ID to delete'),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (args: any, options: any) => {
          const { scheduleId, stepId } = args;
          const userId = options.context?.userId as string;
          await scheduleService.deleteScheduleStep(stepId, userId, scheduleId);
          return {
            success: true,
            message: 'Step deleted successfully',
          };
        },
      }) as any,

      validateSteps: tool({
        description:
          'Validate the schedule configuration to check for errors or issues in the step sequence',
        parameters: z.object({
          scheduleId: z.string().uuid().describe('The schedule ID to validate'),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (args: any, options: any) => {
          const { scheduleId } = args;
          const userId = options.context?.userId as string;
          const steps = await scheduleService.getScheduleSteps(userId, scheduleId);

          // Basic validation logic
          const issues: string[] = [];

          if (steps.length === 0) {
            issues.push('Schedule has no steps configured');
          }

          // Check for duplicate step orders
          const orderCounts = new Map<number, number>();
          for (const step of steps) {
            orderCounts.set(step.stepOrder, (orderCounts.get(step.stepOrder) || 0) + 1);
          }
          for (const [order, count] of orderCounts.entries()) {
            if (count > 1) {
              issues.push(`Multiple steps have the same order: ${order}`);
            }
          }

          return {
            success: true,
            isValid: issues.length === 0,
            issues,
            stepCount: steps.length,
          };
        },
      }) as any,

      getHoldings: tool({
        description:
          'Get list of user holdings (token balances in accounts) to use when creating steps',
        parameters: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (_args: any, options: any) => {
          const userId = options.context?.userId as string;
          const holdings = await holdingRepository.findByUser(userId);
          return {
            success: true,
            holdings: holdings.map((h) => ({
              id: h.id,
              tokenId: h.tokenId,
              accountId: h.accountId,
              balance: h.balance,
              source: h.source,
            })),
          };
        },
      }) as any,

      getScheduleStepTypes: tool({
        description: 'Get available schedule step types with their IDs',
        parameters: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: Complex AI SDK tool type overloading
        // @ts-expect-error - AI SDK tool type overloading compatibility issue with VoltAgent
        execute: async (_args: any, _options: any) => {
          const types = await scheduleStepTypeRepository.findAll();
          return {
            success: true,
            types: types.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
            })),
          };
        },
      }) as any,
    };
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
    const { userId, scheduleId, message, conversationId } = params;

    // Generate conversation ID if not provided
    const actualConversationId = conversationId || crypto.randomUUID();

    // Call the agent with the user message and context
    // The agent's memory will automatically store the conversation
    const response = await this.agent.generateText(message, {
      userId,
      conversationId: actualConversationId,
      context: {
        userId,
        scheduleId,
        timezone: 'UTC',
      },
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
