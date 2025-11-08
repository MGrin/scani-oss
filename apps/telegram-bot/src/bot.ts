import { ParseScreenshotUseCase } from '@scani/core/use-cases/ParseScreenshotUseCase';
import type { Context as TelegrafContext } from 'telegraf';
import { Telegraf } from 'telegraf';
import { Container } from 'typedi';
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
  debug(obj: object, msg: string): void;
  debug(msg: string): void;
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
  /**
   * Regex pattern for detecting chart markers in AI responses
   * Matches format: [CHART:base64EncodedImageData]
   * Example: [CHART:iVBORw0KGgoAAAANSUhEUg...]
   */
  private readonly chartPattern = /\[CHART:([A-Za-z0-9+/=]+)\]/;

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
      debug: logMethod('log'), // Use console.log for debug
    };
  }

  /**
   * Escape HTML special characters
   */
  private escapeHTML(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Convert markdown to HTML for Telegram
   * Telegram's HTML mode is more reliable than Markdown for complex formatting
   */
  private convertMarkdownToHTML(markdown: string): string {
    let html = markdown;

    // Convert markdown tables to HTML with proper escaping
    // Match table rows (lines with | separators)
    const tableRegex = /(\|.+\|[\r\n]+)+/g;
    html = html.replace(tableRegex, (table) => {
      const lines = table.trim().split('\n');
      if (lines.length < 2) return table;

      let htmlTable = '<pre>\n';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue; // Skip empty lines

        // Skip separator lines (e.g., |----|----|)
        if (line.match(/^\|[\s\-:]+\|$/)) continue;

        // Clean up the line and escape HTML entities in each cell
        const cells = line
          .split('|')
          .slice(1, -1) // Remove empty first and last elements
          .map((cell) => this.escapeHTML(cell.trim()));

        htmlTable += `${cells.join(' | ')}\n`;
      }
      htmlTable += '</pre>\n';

      return htmlTable;
    });

    // Convert bold: **text** or __text__ to <b>text</b> with escaping
    html = html.replace(
      /\*\*(.+?)\*\*/g,
      (_match, content) => `<b>${this.escapeHTML(content)}</b>`
    );
    html = html.replace(/__(.+?)__/g, (_match, content) => `<b>${this.escapeHTML(content)}</b>`);

    // Convert italic: *text* or _text_ to <i>text</i> (avoid ** and __) with escaping
    html = html.replace(
      /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
      (_match, content) => `<i>${this.escapeHTML(content)}</i>`
    );
    html = html.replace(
      /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
      (_match, content) => `<i>${this.escapeHTML(content)}</i>`
    );

    // Convert code: `text` to <code>text</code> with escaping
    html = html.replace(
      /`(.+?)`/g,
      (_match, content) => `<code>${this.escapeHTML(content)}</code>`
    );

    // Convert links: [text](url) to <a href="url">text</a> with escaping
    html = html.replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_match, text, url) => `<a href="${this.escapeHTML(url)}">${this.escapeHTML(text)}</a>`
    );

    return html;
  }

  /**
   * Generate inline keyboard for chart options
   */
  private getChartInlineKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '📊 Donut Chart', callback_data: 'chart_donut' },
          { text: '📈 Bar Chart', callback_data: 'chart_bar' },
        ],
        [
          { text: '💼 By Accounts', callback_data: 'chart_accounts' },
          { text: '🏦 By Institutions', callback_data: 'chart_institutions' },
        ],
        [
          { text: '🪙 By Tokens', callback_data: 'chart_tokens' },
          { text: '📑 By Asset Type', callback_data: 'chart_types' },
        ],
      ],
    };
  }

  /**
   * Extract caption text from a chart response by removing the chart marker
   */
  private extractChartCaption(response: string): string {
    return response.replace(this.chartPattern, '').trim();
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
        '📚 Available Commands:\n\n' +
          '/start - Start the bot\n' +
          '/help - Show this help message\n' +
          '/tools - List all available tools and capabilities\n' +
          '/auth <token> - Link your Scani account with auth token\n' +
          '/status - Check authentication status\n' +
          '/reset - Reset conversation context\n' +
          '/daily - Generate daily portfolio update (for testing)\n\n' +
          'Natural Language:\n' +
          'You can also chat with me naturally! Ask me to:\n' +
          '• Show your portfolio overview\n' +
          '• List your accounts or holdings\n' +
          '• Add new holdings\n' +
          '• Check token prices\n' +
          '• Import a crypto wallet\n' +
          '• And much more!\n\n' +
          'Screenshot Upload:\n' +
          'You can also send me screenshots of your portfolio or holdings, and I will analyze them for you!'
      );
    });

    // Tools command - list available capabilities
    this.bot.command('tools', async (ctx) => {
      const { getToolsList } = await import('./tools');
      const toolsList = getToolsList();

      // Split into multiple messages if too long
      const maxLength = 4000;
      if (toolsList.length <= maxLength) {
        await ctx.reply(toolsList, { parse_mode: 'Markdown' });
      } else {
        // Split by category
        const lines = toolsList.split('\n\n');
        let currentMessage = '';

        for (const line of lines) {
          if ((currentMessage + line).length > maxLength) {
            await ctx.reply(currentMessage, { parse_mode: 'Markdown' });
            currentMessage = `${line}\n\n`;
          } else {
            currentMessage += `${line}\n\n`;
          }
        }

        if (currentMessage) {
          await ctx.reply(currentMessage, { parse_mode: 'Markdown' });
        }
      }
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
          '🔐 Authentication Required\n\n' +
            'To link your Scani account, please provide an authentication token:\n' +
            '/auth YOUR_TOKEN_HERE\n\n' +
            'You can generate a token in the Scani web app:\n' +
            '1. Go to Settings → Integrations\n' +
            '2. Click "Connect Telegram"\n' +
            '3. Copy the generated token\n' +
            '4. Send it here: /auth <token>'
        );
        return;
      }

      try {
        await this.config.linkTelegramUser(telegramUserId, telegramUsername, authToken);
        await ctx.reply(
          '✅ Authentication Successful!\n\n' +
            'Your Telegram account is now linked to your Scani profile.\n' +
            'You can start chatting with me to manage your portfolio!'
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

    // Daily digest command (for testing)
    this.bot.command('daily', async (ctx) => {
      if (!ctx.userId) {
        await ctx.reply('❌ You are not authenticated. Use /auth <token> to link your account.');
        return;
      }

      try {
        await ctx.sendChatAction('typing');
        await ctx.reply('📊 Generating your daily portfolio update...');

        // Generate AI-powered daily digest
        const digest = await this.aiAgent.generateDailyDigest(ctx.userId);

        // Send the digest
        await ctx.reply(digest, { parse_mode: 'HTML' });
      } catch (error) {
        this.logger.error({ error }, 'Error generating daily digest');
        await ctx.reply(
          '❌ Sorry, I encountered an error generating your daily digest. Please try again later.'
        );
      }
    });

    // Handle photo messages (screenshot upload)
    this.bot.on('photo', async (ctx) => {
      const telegramUserId = ctx.telegramUserId;

      if (!ctx.userId || !telegramUserId) {
        await ctx.reply(
          '⚠️ Please authenticate first using /auth <token> before uploading photos.\n\n' +
            'Get your auth token from the Scani web app (Settings → Integrations).'
        );
        return;
      }

      try {
        // Show processing indicator
        await ctx.sendChatAction('typing');

        // Get the largest photo (best quality)
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        if (!photo) {
          await ctx.reply('❌ Failed to get photo data. Please try again.');
          return;
        }

        // Get file from Telegram
        const file = await ctx.telegram.getFile(photo.file_id);
        if (!file.file_path) {
          await ctx.reply('❌ Failed to get photo file path. Please try again.');
          return;
        }

        // Download the file as base64
        const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');

        // Get caption as context if provided
        const caption = ctx.message.caption || undefined;

        await ctx.reply('🔍 Analyzing your screenshot... This may take a moment.');

        // Parse screenshot using ParseScreenshotUseCase
        const parseScreenshotUseCase = Container.get(ParseScreenshotUseCase);
        const parseResult = await parseScreenshotUseCase.execute({
          imageBase64: base64,
          context: caption,
          userId: ctx.userId,
        });

        // Format the results for the user
        if (parseResult.holdings.length === 0) {
          await ctx.reply(
            '❌ I could not detect any holdings in this screenshot.\n\n' +
              'Please make sure the screenshot clearly shows:\n' +
              '• Token symbols or names\n' +
              '• Quantities/amounts\n\n' +
              'Try uploading a clearer screenshot or ask me to help you add holdings manually.'
          );
          return;
        }

        // Format holdings list
        let responseMessage = `✅ Found ${parseResult.holdings.length} holding(s) in your screenshot:\n\n`;

        for (const holding of parseResult.holdings) {
          const confidenceEmoji =
            holding.confidence >= 0.8 ? '✓' : holding.confidence >= 0.5 ? '?' : '⚠';
          responseMessage += `${confidenceEmoji} ${holding.symbol}: ${holding.balance}`;
          if (holding.name) {
            responseMessage += ` (${holding.name})`;
          }
          if (holding.existingBalance) {
            responseMessage += ` - Existing: ${holding.existingBalance}`;
          }
          responseMessage += '\n';
        }

        responseMessage += `\nOverall confidence: ${Math.round(
          parseResult.overallConfidence * 100
        )}%\n\n`;

        if (parseResult.detectedCurrency) {
          responseMessage += `Detected currency: ${parseResult.detectedCurrency}\n`;
        }

        if (parseResult.context) {
          responseMessage += `\nNote: ${parseResult.context}\n`;
        }

        responseMessage +=
          '\nTo import these holdings, you can:\n' +
          '1. Ask me to "add these holdings to [account name]"\n' +
          '2. Or provide more details about which account to add them to';

        await ctx.reply(responseMessage);

        // Update conversation context
        let conversationContext = this.conversationContexts.get(telegramUserId);
        if (!conversationContext) {
          conversationContext = {
            userId: ctx.userId,
            conversationHistory: [],
          };
          this.conversationContexts.set(telegramUserId, conversationContext);
        }

        conversationContext.userId = ctx.userId;
        conversationContext.conversationHistory.push({
          role: 'user',
          content: `User uploaded a screenshot with ${parseResult.holdings.length} holdings detected`,
        });
        conversationContext.conversationHistory.push({
          role: 'assistant',
          content: responseMessage,
        });

        // Keep only last 20 messages
        if (conversationContext.conversationHistory.length > 20) {
          conversationContext.conversationHistory =
            conversationContext.conversationHistory.slice(-20);
        }
      } catch (error) {
        this.logger.error({ error }, 'Error processing photo');
        await ctx.reply(
          '❌ Sorry, I encountered an error processing your photo. Please try again or use /reset to start over.'
        );
      }
    });

    // Handle inline keyboard callbacks for charts
    this.bot.on('callback_query', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();

      if (!ctx.userId || !telegramUserId) {
        await ctx.answerCbQuery('⚠️ Please authenticate first using /auth');
        return;
      }

      // Get callback data
      const callbackData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

      if (!callbackData) {
        await ctx.answerCbQuery('❌ Invalid callback data');
        return;
      }

      // Answer the callback query to remove loading state
      await ctx.answerCbQuery();

      // Parse chart request from callback data
      if (callbackData.startsWith('chart_')) {
        const chartRequest = callbackData.replace('chart_', '');
        let message = '';

        // Map callback data to natural language request
        // Buttons either specify chart type (donut/bar) or data grouping (accounts/institutions/tokens/types)
        switch (chartRequest) {
          case 'donut':
            message = 'Show me a donut chart of my portfolio';
            break;
          case 'bar':
            message = 'Show me a bar chart of my portfolio';
            break;
          case 'accounts':
            message = 'Show me a chart of my portfolio grouped by accounts';
            break;
          case 'institutions':
            message = 'Show me a chart of my portfolio grouped by institutions';
            break;
          case 'tokens':
            message = 'Show me a chart of my top holdings grouped by token';
            break;
          case 'types':
            message = 'Show me a chart of my asset allocation grouped by type';
            break;
          default:
            await ctx.reply('❌ Unknown chart type');
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

        // Show typing indicator
        await ctx.sendChatAction('typing');

        try {
          // Get AI response for the chart request
          const response = await this.aiAgent.chat(message, conversationContext);

          // Check if response contains a chart
          const chartMatch = response.match(this.chartPattern);
          if (chartMatch?.[1]) {
            const chartBase64 = chartMatch[1];
            const chartBuffer = Buffer.from(chartBase64, 'base64');

            // Extract caption
            const caption = this.extractChartCaption(response);

            // Show upload photo indicator
            await ctx.sendChatAction('upload_photo');

            // Send chart as photo
            await ctx.replyWithPhoto(
              { source: chartBuffer },
              {
                caption: caption || 'Your portfolio chart',
                reply_markup: this.getChartInlineKeyboard(),
              }
            );
          } else {
            // If no chart in response, send text
            const htmlResponse = this.convertMarkdownToHTML(response);
            await ctx.reply(htmlResponse, { parse_mode: 'HTML' });
          }

          // Update conversation history
          conversationContext.conversationHistory.push({
            role: 'user',
            content: message,
          });
          conversationContext.conversationHistory.push({
            role: 'assistant',
            content: response,
          });

          // Keep only last 20 messages
          if (conversationContext.conversationHistory.length > 20) {
            conversationContext.conversationHistory =
              conversationContext.conversationHistory.slice(-20);
          }
        } catch (error) {
          this.logger.error({ error }, 'Error processing chart callback');
          await ctx.reply(
            '❌ Sorry, I encountered an error generating the chart. Please try again or use /reset to start over.'
          );
        }
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

        // Check if response contains a chart (base64 encoded image)
        const chartMatch = response.match(this.chartPattern);
        if (chartMatch?.[1]) {
          const chartBase64 = chartMatch[1];
          const chartBuffer = Buffer.from(chartBase64, 'base64');

          // Extract caption (everything after the chart marker)
          const caption = this.extractChartCaption(response);

          // Show upload photo indicator before sending
          await ctx.sendChatAction('upload_photo');

          // Send chart as photo with caption (plain text, no HTML parsing needed for chart captions)
          await ctx.replyWithPhoto(
            { source: chartBuffer },
            {
              caption: caption || 'Your portfolio chart',
              reply_markup: this.getChartInlineKeyboard(),
            }
          );
        } else {
          // Convert markdown to HTML and send as text
          const htmlResponse = this.convertMarkdownToHTML(response);
          await ctx.reply(htmlResponse, { parse_mode: 'HTML' });
        }

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

  /**
   * Send daily portfolio digest to all active Telegram users
   * This method is called by the backend cron job
   * Uses AI to generate personalized, engaging digest messages
   */
  async sendDailyDigestToAllUsers(params: {
    getActiveTelegramUsers: () => Promise<
      Array<{ id: string; telegramId: string; userId: string }>
    >;
    updateLastInteraction: (telegramUserId: string) => Promise<void>;
  }): Promise<{
    successCount: number;
    errorCount: number;
    errors: Array<{ telegramId: string; error: string }>;
  }> {
    const startTime = Date.now();
    this.logger.info('📊 Starting daily digest broadcast');

    // Get all active telegram users
    const activeTelegramUsers = await params.getActiveTelegramUsers();

    this.logger.info(
      { userCount: activeTelegramUsers.length },
      `Found ${activeTelegramUsers.length} active Telegram users`
    );

    // Track results
    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ telegramId: string; error: string }> = [];

    // Send digest to each user with rate limiting
    for (const telegramUser of activeTelegramUsers) {
      try {
        // Generate AI-powered portfolio digest for this user
        const digest = await this.aiAgent.generateDailyDigest(telegramUser.userId);

        // Send to Telegram
        await this.bot.telegram.sendMessage(telegramUser.telegramId, digest, {
          parse_mode: 'HTML',
        });

        successCount++;
        this.logger.debug(
          { telegramId: telegramUser.telegramId, userId: telegramUser.userId },
          'Sent daily digest to user'
        );

        // Update last interaction timestamp
        await params.updateLastInteraction(telegramUser.id);

        // Rate limiting: Wait 100ms between messages to avoid hitting Telegram's 30 msg/sec limit
        // This allows ~10 messages per second, well within limits
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        errorCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          telegramId: telegramUser.telegramId,
          error: errorMessage,
        });
        this.logger.error(
          {
            telegramId: telegramUser.telegramId,
            userId: telegramUser.userId,
            error: errorMessage,
          },
          'Failed to send digest to user'
        );
      }
    }

    const durationMs = Date.now() - startTime;

    this.logger.info(
      {
        totalUsers: activeTelegramUsers.length,
        successCount,
        errorCount,
        durationMs,
      },
      '✅ Daily digest broadcast completed'
    );

    // Log errors if any
    if (errors.length > 0) {
      this.logger.warn(
        {
          errors: errors.slice(0, 10), // Log first 10 errors only
          totalErrors: errors.length,
        },
        'Some users did not receive the daily digest'
      );
    }

    return { successCount, errorCount, errors };
  }
}
