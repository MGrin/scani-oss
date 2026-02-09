import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { ApiKeyService } from './ApiKeyService';
import { BaseService } from './BaseService';

export interface RegisterAgentInput {
  name: string;
}

export interface RegisterAgentResult {
  agentId: string;
  apiKey: string;
  name: string;
  createdAt: Date;
}

export interface LinkAgentToUserInput {
  agentId: string;
  targetUserId: string;
}

export interface LinkAgentToUserResult {
  success: boolean;
  agentId: string;
  linkedToUserId: string;
  message: string;
}

@Service()
export class AgenticUserService extends BaseService {
  private readonly apiKeyService = Container.get(ApiKeyService);

  constructor() {
    super('AgenticUserService');
  }

  /**
   * Register a new agentic user and create their API key
   * Returns the agent ID and plaintext API key (shown only once)
   */
  async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentResult> {
    try {
      this.logInfo('Registering new agentic user', { name: input.name });

      // Validate name
      if (!input.name || input.name.trim().length === 0) {
        throw new Error('Agent name is required');
      }

      if (input.name.length > 100) {
        throw new Error('Agent name must be 100 characters or less');
      }

      const trimmedName = input.name.trim();

      // Get USD token ID as default base currency
      const [usdToken] = await db
        .select({ id: schema.tokens.id })
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'USD'))
        .limit(1);

      // Create the agentic user
      const now = new Date();
      const [newUser] = await db
        .insert(schema.users)
        .values({
          email: null, // Agentic users don't have email
          name: trimmedName,
          avatar: null,
          baseCurrencyId: usdToken?.id || null,
          userType: 'agentic',
          linkedToUserId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!newUser) {
        throw new Error('Failed to create agentic user');
      }

      this.logInfo('Agentic user created', {
        agentId: newUser.id,
        name: trimmedName,
      });

      // Create an API key for the agent
      const apiKeyResult = await this.apiKeyService.createApiKey({
        userId: newUser.id,
        name: `${trimmedName} API Key`,
      });

      this.logInfo('API key created for agentic user', { agentId: newUser.id });

      return {
        agentId: newUser.id,
        apiKey: apiKeyResult.plainKey,
        name: trimmedName,
        createdAt: newUser.createdAt,
      };
    } catch (error) {
      throw this.handleError(error, 'registerAgent');
    }
  }

  /**
   * Link an agentic user to a regular user account
   * This allows merging agent-created data with a real user account
   */
  async linkAgentToUser(input: LinkAgentToUserInput): Promise<LinkAgentToUserResult> {
    try {
      this.logInfo('Linking agentic user to regular user', {
        agentId: input.agentId,
        targetUserId: input.targetUserId,
      });

      // Verify the agentic user exists and is of type 'agentic'
      const [agentUser] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, input.agentId))
        .limit(1);

      if (!agentUser) {
        throw new Error('Agent user not found');
      }

      if (agentUser.userType !== 'agentic') {
        throw new Error('User is not an agentic user');
      }

      if (agentUser.linkedToUserId) {
        throw new Error('Agent is already linked to another user');
      }

      // Verify the target user exists and is a regular user
      const [targetUser] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, input.targetUserId))
        .limit(1);

      if (!targetUser) {
        throw new Error('Target user not found');
      }

      if (targetUser.userType !== 'regular') {
        throw new Error('Can only link to regular user accounts');
      }

      // Update the agentic user to link to the regular user
      const now = new Date();
      await db
        .update(schema.users)
        .set({
          linkedToUserId: input.targetUserId,
          updatedAt: now,
        })
        .where(eq(schema.users.id, input.agentId));

      this.logInfo('Agentic user linked successfully', {
        agentId: input.agentId,
        linkedToUserId: input.targetUserId,
      });

      return {
        success: true,
        agentId: input.agentId,
        linkedToUserId: input.targetUserId,
        message: `Agent "${agentUser.name}" has been linked to user "${targetUser.name}". The agent's data will remain accessible via its API key.`,
      };
    } catch (error) {
      throw this.handleError(error, 'linkAgentToUser');
    }
  }

  /**
   * Get agentic user by ID
   */
  async getAgentById(agentId: string): Promise<typeof schema.users.$inferSelect | null> {
    try {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, agentId))
        .limit(1);

      if (!user || user.userType !== 'agentic') {
        return null;
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'getAgentById');
    }
  }

  /**
   * Check if a user is an agentic user
   */
  async isAgenticUser(userId: string): Promise<boolean> {
    try {
      const [user] = await db
        .select({ userType: schema.users.userType })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      return user?.userType === 'agentic';
    } catch (error) {
      throw this.handleError(error, 'isAgenticUser');
    }
  }

  /**
   * Get agent info for the whoami endpoint
   * Returns basic info about the authenticated agent
   */
  async getAgentInfo(userId: string): Promise<{
    agentId: string;
    name: string;
    userType: string;
    baseCurrency: string | null;
    linkedToUserId: string | null;
    createdAt: Date;
  } | null> {
    try {
      const [user] = await db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          userType: schema.users.userType,
          baseCurrencyId: schema.users.baseCurrencyId,
          linkedToUserId: schema.users.linkedToUserId,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return null;
      }

      // Get base currency symbol if set
      let baseCurrencySymbol: string | null = null;
      if (user.baseCurrencyId) {
        const [currency] = await db
          .select({ symbol: schema.tokens.symbol })
          .from(schema.tokens)
          .where(eq(schema.tokens.id, user.baseCurrencyId))
          .limit(1);
        baseCurrencySymbol = currency?.symbol || null;
      }

      return {
        agentId: user.id,
        name: user.name,
        userType: user.userType,
        baseCurrency: baseCurrencySymbol,
        linkedToUserId: user.linkedToUserId,
        createdAt: user.createdAt,
      };
    } catch (error) {
      throw this.handleError(error, 'getAgentInfo');
    }
  }
}
