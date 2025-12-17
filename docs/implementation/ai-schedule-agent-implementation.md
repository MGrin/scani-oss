# AI Schedule Agent Implementation Guide

## Overview

This document describes the implementation of the AI-powered schedule step configuration feature, which replaces the manual form-based approach with an intelligent chat interface powered by VoltAgent.

## What Was Implemented

### Frontend Changes

1. **ScheduleDetail Page Restructure**
   - Removed the "Add Step" button and manual form dialog
   - Added tabbed interface with "Overview" and "Modify" tabs
   - Overview tab displays the existing schedule workflow
   - Modify tab contains the AI chat interface
   - Auto-switches to Modify tab when no steps exist

2. **AIScheduleChat Component** (`apps/frontendV2/src/components/features/AIScheduleChat.tsx`)
   - Chat-style UI with user and assistant messages
   - Real-time message display with timestamps
   - Auto-scrolling to latest messages
   - Connected to backend via tRPC
   - Loading states and error handling

### Backend Changes

1. **AI Chat Router** (`apps/backend/src/presentation/routers/ai-chat.ts`)
   - `sendMessage`: Endpoint for sending messages to the AI agent
   - `getConversation`: Retrieve conversation history
   - `clearConversation`: Clear conversation history
   - All endpoints protected with authentication

2. **Main Router Integration**
   - Added `aiChat` router to the main application router
   - Available at `trpc.aiChat.*` endpoints

### Dependencies Added

- `@voltagent/core`: Core VoltAgent framework
- `@voltagent/vercel-ui`: UI components for VoltAgent
- `@voltagent/server-hono`: Server integration
- `ai`: Vercel AI SDK
- `@ai-sdk/openai`: OpenAI integration for Vercel AI SDK

## What Still Needs Implementation

### 1. VoltAgent Backend Integration

The current implementation has placeholder responses. To complete the feature:

#### Create VoltAgent Agent Service

```typescript
// apps/backend/src/application/services/ScheduleAgentService.ts

import { Agent, VoltAgent } from '@voltagent/core';
import { VercelAIProvider } from '@voltagent/vercel-ai';
import { openai } from '@ai-sdk/openai';
import { createTool } from '@voltagent/core';
import { z } from 'zod';

export class ScheduleAgentService {
  private agent: Agent;
  
  constructor() {
    this.agent = new Agent({
      name: 'schedule-configurator',
      description: 'AI assistant for configuring schedule steps',
      llm: new VercelAIProvider(),
      model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
      tools: [
        this.createInflowStepTool(),
        this.createOutflowStepTool(),
        this.createTransferStepTool(),
        this.createConversionStepTool(),
      ],
    });
  }
  
  private createInflowStepTool() {
    return createTool({
      name: 'create_inflow_step',
      description: 'Creates an inflow step (money coming in)',
      parameters: z.object({
        scheduleId: z.string().uuid(),
        from: z.string(),
        toHoldingId: z.string().uuid(),
        amount: z.string(),
      }),
      execute: async ({ scheduleId, from, toHoldingId, amount }) => {
        // Call ScheduleService.createScheduleStep
        return { success: true, stepId: '...' };
      },
    });
  }
  
  // Similar tools for outflow, transfer, conversion
}
```

#### Update AI Chat Router

```typescript
// apps/backend/src/presentation/routers/ai-chat.ts

import { Container } from 'typedi';
import { ScheduleAgentService } from '../../application/services/ScheduleAgentService';

const agentService = Container.get(ScheduleAgentService);

export const aiChatRouter = router({
  sendMessage: protectedProcedure
    .input(/* ... */)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);
      
      const response = await agentService.agent.generateText(input.message, {
        userId: dbUser.id,
        conversationId: input.conversationId,
        context: {
          scheduleId: input.scheduleId,
        },
      });
      
      return {
        id: crypto.randomUUID(),
        message: response.text,
        timestamp: new Date().toISOString(),
        conversationId: input.conversationId,
      };
    }),
});
```

### 2. Environment Configuration

Add to `.env`:

```bash
# OpenAI Configuration
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini  # or gpt-4o for better quality

# VoltAgent Configuration (optional)
VOLTAGENT_API_KEY=...  # For VoltOps Platform observability
```

### 3. Conversation Persistence

Currently conversations are ephemeral. To persist:

1. Create database schema for conversations:
   ```typescript
   export const conversations = pgTable('conversations', {
     id: uuid('id').primaryKey().defaultRandom(),
     userId: uuid('user_id').notNull().references(() => users.id),
     scheduleId: uuid('schedule_id').notNull().references(() => schedules.id),
     createdAt: timestamp('created_at').notNull().defaultNow(),
   });
   
   export const conversationMessages = pgTable('conversation_messages', {
     id: uuid('id').primaryKey().defaultRandom(),
     conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
     role: text('role').notNull(), // 'user' | 'assistant'
     content: text('content').notNull(),
     timestamp: timestamp('timestamp').notNull().defaultNow(),
   });
   ```

2. Implement storage in the router

### 4. Enhanced AI Capabilities

Consider adding:

- **Context Awareness**: Load schedule type, existing steps, holdings, accounts
- **Validation**: AI should validate step configurations against business rules
- **Multi-step Creation**: Allow creating multiple steps in one conversation
- **Step Modification**: Tools to edit/delete existing steps
- **Natural Language Understanding**: Handle queries like "Add a step to transfer 30% of my paycheck to savings"

### 5. Testing

Create tests for:
- Frontend chat component
- Backend AI chat router
- VoltAgent agent responses
- Tool executions
- Error handling

## Architecture Decisions

### Why VoltAgent?

1. **TypeScript-first**: Perfect fit for the existing stack
2. **Tool-based**: Natural mapping to schedule operations
3. **Observability**: Built-in tracing and debugging
4. **Flexibility**: Works with multiple LLM providers

### Design Patterns Used

1. **Clean Architecture**: Following existing patterns (use cases, services, routers)
2. **SOLID Principles**: Single responsibility, dependency injection
3. **Type Safety**: Full TypeScript type safety end-to-end

## User Experience Flow

1. User navigates to a schedule detail page
2. If no steps exist, they automatically see the "Modify" tab with the AI chat
3. User asks the AI to create steps (e.g., "Add an inflow step from my employer for $5000")
4. AI uses tools to create the step via the backend service
5. User switches to "Overview" tab to see the created workflow
6. User can continue chatting to modify or add more steps

## Security Considerations

- All endpoints require authentication
- User can only modify their own schedules
- AI responses are validated before creating steps
- Rate limiting should be added to prevent abuse

## Performance Considerations

- Messages are sent asynchronously
- Auto-scrolling is optimized with refs
- Conversation history can be paginated if needed
- Consider caching frequently used context (holdings, schedule types)

## Known Limitations

1. No streaming responses (can be added with `agent.streamText`)
2. No conversation persistence (in-memory only)
3. Basic error handling
4. No rate limiting
5. No multi-language support

## Future Enhancements

- Streaming AI responses for better UX
- Voice input/output
- Schedule step suggestions based on patterns
- Integration with other features (budgets, forecasts)
- Batch step creation
- Schedule templates via AI

## References

- [VoltAgent Documentation](https://voltagent.dev/docs/)
- [VoltAgent GitHub](https://github.com/voltagent/voltagent)
- [Project Architecture](../../ARCHITECTURE.md)
