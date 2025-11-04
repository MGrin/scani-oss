import type { Context as TelegrafContext } from 'telegraf';
import { Telegraf } from 'telegraf';

export interface TelegramBotConfig {
  botToken: string;
  openAIApiKey: string;
}

export interface BotContext extends TelegrafContext {
  userId?: string; // Scani user ID after authentication
  telegramUserId?: string;
}

export class TelegramBotService {
  private bot: Telegraf<BotContext>;
  private isRunning = false;

  constructor(private config: TelegramBotConfig) {
    this.bot = new Telegraf<BotContext>(config.botToken);
    this.setupHandlers();
  }

  private setupHandlers() {
    // Start command
    this.bot.command('start', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      ctx.telegramUserId = telegramUserId;

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
          '/auth - Link your Scani account\n' +
          '/status - Check authentication status\n\n' +
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

    // Auth command
    this.bot.command('auth', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      if (!telegramUserId) {
        await ctx.reply('❌ Unable to identify your Telegram account.');
        return;
      }

      await ctx.reply(
        '🔐 *Authentication Required*\n\n' +
          'To link your Scani account:\n\n' +
          '1. Open the Scani web app\n' +
          '2. Go to Settings → Integrations\n' +
          '3. Click "Connect Telegram"\n' +
          '4. Use this code: `' +
          telegramUserId +
          '`\n\n' +
          'This will securely link your Telegram account to your Scani profile.',
        { parse_mode: 'Markdown' }
      );
    });

    // Status command
    this.bot.command('status', async (ctx) => {
      // TODO: Check if user is authenticated
      const isAuthenticated = false; // Placeholder

      if (isAuthenticated) {
        await ctx.reply('✅ You are authenticated and ready to use the bot!');
      } else {
        await ctx.reply('❌ You are not authenticated. Use /auth to link your account.');
      }
    });

    // Handle all other text messages
    this.bot.on('text', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      ctx.telegramUserId = telegramUserId;

      // TODO: Check authentication
      const isAuthenticated = false; // Placeholder

      if (!isAuthenticated) {
        await ctx.reply(
          '⚠️ Please authenticate first using the /auth command before chatting with me.'
        );
        return;
      }

      // TODO: Handle with AI agent
      await ctx.reply('🤖 AI agent functionality coming soon! Your message: ' + ctx.message.text);
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      console.error('Bot error:', err);
      ctx.reply('❌ An error occurred. Please try again later.');
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Telegram bot is already running');
      return;
    }

    try {
      await this.bot.launch();
      this.isRunning = true;
      console.log('✅ Telegram bot started successfully');
    } catch (error) {
      console.error('❌ Failed to start Telegram bot:', error);
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
      console.log('✅ Telegram bot stopped successfully');
    } catch (error) {
      console.error('❌ Failed to stop Telegram bot:', error);
      throw error;
    }
  }

  getBot(): Telegraf<BotContext> {
    return this.bot;
  }
}
