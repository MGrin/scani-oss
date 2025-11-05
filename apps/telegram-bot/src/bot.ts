import type { Context as TelegrafContext } from 'telegraf';
import { Telegraf } from 'telegraf';
import type { ConversationContext } from './ai-agent';
import { AIAgent } from './ai-agent';

// Minimal logger interface compatible with pino
export interface Logger {
  info(obj: object, msg: string): void;
  info(msg: string): void;
  warn(obj: object, msg: string): void;
  warn(msg: string): void;
  error(obj: object, msg: string): void;
  error(msg: string): void;
}

export interface TelegramBotConfig {
  botToken: string;
  openAIApiKey: string;
  getAuthenticatedUser: (telegramId: string) => Promise<{ userId: string } | null>;
  linkTelegramUser: (
    telegramId: string,
    telegramUsername: string | undefined,
    authToken: string
  ) => Promise<void>;
  logger?: Logger; // Optional logger, falls back to console if not provided
}

export interface BotContext extends TelegrafContext {
  userId?: string; // Scani user ID after authentication
  telegramUserId?: string;
}

export class TelegramBotService {
  private bot: Telegraf<BotContext>;
  private isRunning = false;
  private aiAgent: AIAgent;
  private conversationContexts: Map<string, ConversationContext> = new Map();
  private logger: Logger;

  constructor(private config: TelegramBotConfig) {
    this.bot = new Telegraf<BotContext>(config.botToken);
    this.aiAgent = new AIAgent({
      openAIApiKey: config.openAIApiKey,
    });
    // Use provided logger or fallback to console
    this.logger = config.logger || this.createConsoleLogger();
    this.setupHandlers();
  }

  // Helper to create a console-based logger fallback
  private createConsoleLogger(): Logger {
    const logMethod = (method: 'log' | 'warn' | 'error') => {
      return (arg1: object | string, arg2?: string) => {
        if (typeof arg1 === 'string') {
          console[method](arg1);
        } else {
          console[method](arg2, arg1);
        }
      };
    };

    return {
      info: logMethod('log'),
      warn: logMethod('warn'),
      error: logMethod('error'),
    };
  }

  private setupHandlers() {
    // Middleware to check authentication
    this.bot.use(async (ctx, next) => {
      const telegramUserId = ctx.from?.id.toString();
      if (telegramUserId) {
        ctx.telegramUserId = telegramUserId;
        const authResult = await this.config.getAuthenticatedUser(telegramUserId);
        if (authResult) {
          ctx.userId = authResult.userId;
        }
      }
      return next();
    });

    // Start command
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '👋 Welcome to Scani Finance Bot!\n\n' +
          'I can help you manage your portfolio through natural conversation.\n\n' +
          'To get started, you need to authenticate your account.\n' +
          'Use the /auth command to link your Scani account.'
      );
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '📚 *Available Commands:*\n\n' +
          '/start - Start the bot\n' +
          '/help - Show this help message\n' +
          '/auth <token> - Link your Scani account with auth token\n' +
          '/status - Check authentication status\n' +
          '/reset - Reset conversation context\n\n' +
          '*Natural Language:*\n' +
          'You can also chat with me naturally! Ask me to:\n' +
          '• Show your portfolio overview\n' +
          '• List your accounts or holdings\n' +
          '• Add new holdings\n' +
          '• Check token prices\n' +
          '• And much more!',
        { parse_mode: 'Markdown' }
      );
    });

    // Auth command with token
    this.bot.command('auth', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      const telegramUsername = ctx.from?.username;

      if (!telegramUserId) {
        await ctx.reply('❌ Unable to identify your Telegram account.');
        return;
      }

      // Extract token from command
      const args = ctx.message.text.split(' ').slice(1);
      const authToken = args[0];

      if (!authToken) {
        await ctx.reply(
          '🔐 *Authentication Required*\n\n' +
            'To link your Scani account, please provide an authentication token:\n' +
            '`/auth YOUR_TOKEN_HERE`\n\n' +
            'You can generate a token in the Scani web app:\n' +
            '1. Go to Settings → Integrations\n' +
            '2. Click "Connect Telegram"\n' +
            '3. Copy the generated token\n' +
            '4. Send it here: `/auth <token>`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        await this.config.linkTelegramUser(telegramUserId, telegramUsername, authToken);
        await ctx.reply(
          '✅ *Authentication Successful!*\n\n' +
            'Your Telegram account is now linked to your Scani profile.\n' +
            'You can start chatting with me to manage your portfolio!',
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        this.logger.error({ error }, 'Auth error during Telegram authentication');
        await ctx.reply(
          '❌ Authentication failed. Please make sure you have a valid token from the Scani web app.'
        );
      }
    });

    // Status command
    this.bot.command('status', async (ctx) => {
      if (ctx.userId) {
        await ctx.reply('✅ You are authenticated and ready to use the bot!');
      } else {
        await ctx.reply('❌ You are not authenticated. Use /auth <token> to link your account.');
      }
    });

    // Reset conversation
    this.bot.command('reset', async (ctx) => {
      const telegramUserId = ctx.telegramUserId;
      if (telegramUserId) {
        this.conversationContexts.delete(telegramUserId);
        await ctx.reply('🔄 Conversation context has been reset.');
      }
    });

    // Handle all other text messages
    this.bot.on('text', async (ctx) => {
      const telegramUserId = ctx.telegramUserId;

      if (!ctx.userId || !telegramUserId) {
        await ctx.reply(
          '⚠️ Please authenticate first using /auth <token> before chatting with me.\n\n' +
            'Get your auth token from the Scani web app (Settings → Integrations).'
        );
        return;
      }

      // Get or create conversation context
      let conversationContext = this.conversationContexts.get(telegramUserId);
      if (!conversationContext) {
        conversationContext = {
          userId: ctx.userId,
          conversationHistory: [],
        };
        this.conversationContexts.set(telegramUserId, conversationContext);
      }

      // Update user ID in case it changed
      conversationContext.userId = ctx.userId;

      // Show typing indicator
      await ctx.sendChatAction('typing');

      try {
        // Get AI response
        const response = await this.aiAgent.chat(ctx.message.text, conversationContext);

        // Update conversation history
        conversationContext.conversationHistory.push({
          role: 'user',
          content: ctx.message.text,
        });
        conversationContext.conversationHistory.push({
          role: 'assistant',
          content: response,
        });

        // Keep only last 10 messages to avoid context getting too large
        if (conversationContext.conversationHistory.length > 20) {
          conversationContext.conversationHistory =
            conversationContext.conversationHistory.slice(-20);
        }

        await ctx.reply(response, { parse_mode: 'Markdown' });
      } catch (error) {
        this.logger.error({ error }, 'Error processing Telegram message');
        await ctx.reply(
          '❌ Sorry, I encountered an error processing your request. Please try again or use /reset to start over.'
        );
      }
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error({ error: err }, 'Telegram bot error');
      ctx.reply('❌ An error occurred. Please try again later.');
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('⚠️ Telegram bot is already running');
      return;
    }

    try {
      // Delete any existing webhook to prevent conflicts
      // This ensures we're using polling (getUpdates) and not webhook mode
      this.logger.info('🔄 Deleting existing webhook (if any)...');
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });

      // Launch with dropPendingUpdates to force kill any existing bot instances
      // This resolves 409 Conflict errors from multiple getUpdates requests
      this.logger.info('🚀 Launching bot with dropPendingUpdates...');
      await this.bot.launch({
        dropPendingUpdates: true,
      });
      this.isRunning = true;
      this.logger.info('✅ Telegram bot started successfully');
    } catch (error) {
      this.logger.error({ error }, '❌ Failed to start Telegram bot');
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.bot.stop();
      this.isRunning = false;
      this.logger.info('✅ Telegram bot stopped successfully');
    } catch (error) {
      this.logger.error({ error }, '❌ Failed to stop Telegram bot');
      throw error;
    }
  }

  getBot(): Telegraf<BotContext> {
    return this.bot;
  }
}
