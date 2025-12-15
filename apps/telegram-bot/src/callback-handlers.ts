/**
 * Callback Query Handlers for Inline Keyboards
 * Handles all button interactions in the Telegram bot
 */

import type { InlineKeyboardButton } from 'telegraf/types';
import type { AIAgent } from './ai-agent';
import type { BotContext, Logger } from './bot';
import { formatErrorMessage, getAuthRequiredText } from './commands';
import {
  getAccountsMenu,
  getChartMenu,
  getDashboardMenu,
  getHoldingsMenu,
  getInstitutionsMenu,
  getMainMenu,
  getSettingsMenu,
} from './menus';

/**
 * Session state for multi-step operations
 */
interface SessionState {
  chartType?: 'donut' | 'bar';
  dataType?: 'tokens' | 'accounts' | 'institutions' | 'tokenTypes';
  currentPage?: number;
  awaitingInput?: 'wallet_address' | 'holding_data' | 'price_alert';
}

/**
 * Callback handler class to manage all inline keyboard interactions
 */
export class CallbackHandler {
  private sessionStates: Map<string, SessionState> = new Map();

  constructor(
    private aiAgent: AIAgent,
    private conversationContexts: Map<string, unknown>,
    private logger: Logger
  ) {}

  /**
   * Main callback query handler - routes to appropriate handler
   */
  async handleCallback(ctx: BotContext): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.answerCbQuery('❌ Invalid callback');
      return;
    }

    const callbackData = ctx.callbackQuery.data;
    const telegramUserId = ctx.from?.id.toString();

    // Answer callback query to remove loading state
    await ctx.answerCbQuery();

    try {
      // Route to appropriate handler based on callback data prefix
      if (callbackData.startsWith('menu_')) {
        await this.handleMenuNavigation(ctx, callbackData);
      } else if (callbackData.startsWith('dashboard_')) {
        await this.handleDashboardAction(ctx, callbackData);
      } else if (callbackData.startsWith('holdings_')) {
        await this.handleHoldingsAction(ctx, callbackData);
      } else if (callbackData.startsWith('accounts_')) {
        await this.handleAccountsAction(ctx, callbackData);
      } else if (callbackData.startsWith('institutions_')) {
        await this.handleInstitutionsAction(ctx, callbackData);
      } else if (callbackData.startsWith('allocation_')) {
        await this.handleAllocationAction(ctx, callbackData);
      } else if (callbackData.startsWith('chart_')) {
        await this.handleChartAction(ctx, callbackData, telegramUserId);
      } else if (callbackData.startsWith('settings_')) {
        await this.handleSettingsAction(ctx, callbackData);
      } else if (callbackData.startsWith('action_')) {
        await this.handleGeneralAction(ctx, callbackData);
      } else if (callbackData === 'page_info') {
        // Page info button - do nothing, just acknowledge
        return;
      } else {
        // Unknown callback
        this.logger.warn({ callbackData }, 'Unknown callback data');
        await ctx.reply('❌ Unknown action. Please try again or use /menu');
      }
    } catch (error) {
      this.logger.error({ error, callbackData }, 'Error handling callback');
      await ctx.reply(formatErrorMessage(error, 'Processing Action'), { parse_mode: 'HTML' });
    }
  }

  /**
   * Handle menu navigation
   */
  private async handleMenuNavigation(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    let menuData: { text: string; keyboard: InlineKeyboardButton[][] };

    switch (callbackData) {
      case 'menu_main':
        menuData = getMainMenu();
        break;
      case 'menu_dashboard':
        menuData = getDashboardMenu();
        break;
      case 'menu_holdings':
        menuData = getHoldingsMenu();
        break;
      case 'menu_accounts':
        menuData = getAccountsMenu();
        break;
      case 'menu_institutions':
        menuData = getInstitutionsMenu();
        break;
      case 'menu_charts':
        menuData = getChartMenu();
        break;
      case 'menu_settings':
        menuData = getSettingsMenu();
        break;
      default:
        await ctx.reply('❌ Unknown menu. Use /menu to start over.');
        return;
    }

    await ctx.editMessageText(menuData.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: menuData.keyboard },
    });
  }

  /**
   * Handle dashboard actions
   */
  private async handleDashboardAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    switch (callbackData) {
      case 'dashboard_overview':
        await this.delegateToAI(ctx, 'Show me my complete dashboard overview');
        break;

      case 'dashboard_allocation':
        await ctx.reply(
          '📈 <b>Asset Allocation</b>\n\n' +
            'Choose how to view your portfolio distribution:\n\n' +
            '🪙 <b>By Token</b> - Individual holdings\n' +
            '📑 <b>By Token Type</b> - Asset class allocation\n' +
            '💼 <b>By Account</b> - Account distribution\n' +
            '🏦 <b>By Institution</b> - Institution breakdown',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🪙 By Token', callback_data: 'allocation_token' },
                  { text: '📑 By Token Type', callback_data: 'allocation_token_type' },
                ],
                [
                  { text: '💼 By Account', callback_data: 'allocation_account' },
                  { text: '🏦 By Institution', callback_data: 'allocation_institution' },
                ],
                [{ text: '🔙 Back', callback_data: 'menu_dashboard' }],
              ],
            },
          }
        );
        break;

      case 'dashboard_top':
        await this.delegateToAI(ctx, 'Show me my top 10 holdings by value');
        break;

      case 'dashboard_prices':
        await this.delegateToAI(ctx, 'Show me 24-hour price changes for my holdings');
        break;

      default:
        await ctx.reply('❌ Unknown dashboard action');
    }
  }

  /**
   * Handle holdings actions
   */
  private async handleHoldingsAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    switch (callbackData) {
      case 'holdings_list':
        await this.delegateToAI(ctx, 'List all my holdings with complete details');
        break;

      case 'holdings_search':
        await ctx.reply(
          '🔍 <b>Search Holdings</b>\n\n' +
            'Search for specific holdings in your portfolio.\n\n' +
            '<b>How to search:</b>\n' +
            'Just ask me naturally!\n\n' +
            '<b>Examples:</b>\n' +
            '• "Find my BTC holdings"\n' +
            '• "Search for holdings in my Coinbase account"\n' +
            '• "Show USD holdings"\n\n' +
            'What would you like to find? 🔎',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_holdings' }]],
            },
          }
        );
        break;

      case 'holdings_add':
        await ctx.reply(
          '➕ <b>Add New Holding</b>\n\n' +
            'Add holdings to your portfolio naturally!\n\n' +
            '<b>Examples:</b>\n' +
            '• "Add 0.5 BTC to my Coinbase account"\n' +
            '• "Add 100 shares of AAPL to Robinhood"\n' +
            '• "Add 1000 USD to my checking account"\n\n' +
            'Tell me what you want to add! 💬',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_holdings' }]],
            },
          }
        );
        break;

      case 'holdings_screenshot':
        await ctx.reply(
          '📸 <b>Import from Screenshot</b>\n\n' +
            'Send me a clear screenshot of your holdings.\n\n' +
            '<b>What I can detect:</b>\n' +
            '• Token symbols (BTC, ETH, AAPL, etc.)\n' +
            '• Quantities and amounts\n' +
            '• Account names\n\n' +
            '<b>Tips for best results:</b>\n' +
            '• Use clear, high-quality screenshots\n' +
            '• Ensure text is readable\n' +
            '• Include both symbols and quantities\n\n' +
            'Ready? Send your screenshot now! 📤',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_holdings' }]],
            },
          }
        );
        break;

      case 'holdings_wallet':
        await ctx.reply(
          '💰 <b>Import Crypto Wallet</b>\n\n' +
            'Import holdings from a blockchain wallet address.\n\n' +
            '<b>How to import:</b>\n' +
            'Simply tell me the wallet address!\n\n' +
            '<b>Example:</b>\n' +
            '"Import wallet 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"\n\n' +
            'Ready? Send your wallet address now! 🔗',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_holdings' }]],
            },
          }
        );
        break;

      default:
        await ctx.reply('❌ Unknown holdings action');
    }
  }

  /**
   * Handle accounts actions
   */
  private async handleAccountsAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    switch (callbackData) {
      case 'accounts_list':
        await this.delegateToAI(ctx, 'Show me all my accounts with their values');
        break;

      case 'accounts_add':
        await ctx.reply(
          '➕ <b>Add New Account</b>\n\n' +
            'You can create a new account using natural language!\n\n' +
            '<b>Example:</b>\n' +
            '"Create a new Coinbase account for my crypto holdings"\n\n' +
            '<b>What I need:</b>\n' +
            '• Account name\n' +
            '• Institution (e.g., Coinbase, Chase, Vanguard)\n' +
            '• Account type (optional)\n\n' +
            'Just describe what you want to create! 💬',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_accounts' }]],
            },
          }
        );
        break;

      case 'accounts_institutions':
        await this.delegateToAI(ctx, 'Show me all available institutions');
        break;

      default:
        await ctx.reply('❌ Unknown accounts action');
    }
  }

  /**
   * Handle institutions actions
   */
  private async handleInstitutionsAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    switch (callbackData) {
      case 'institutions_all':
        await this.delegateToAI(ctx, 'List all available financial institutions');
        break;

      case 'institutions_mine':
        await this.delegateToAI(ctx, 'Show me the institutions where I have accounts');
        break;

      case 'institutions_summary':
        await this.delegateToAI(ctx, 'Show my portfolio value breakdown by institution');
        break;

      case 'institutions_types':
        await this.delegateToAI(ctx, 'List all institution types available');
        break;

      default:
        await ctx.reply('❌ Unknown institutions action');
    }
  }

  /**
   * Handle chart-related actions with state management
   */
  private async handleChartAction(
    ctx: BotContext,
    callbackData: string,
    telegramUserId: string | undefined
  ): Promise<void> {
    if (!ctx.userId || !telegramUserId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    // Get or create session state
    const state = this.sessionStates.get(telegramUserId) || {};

    // Handle chart type selection
    if (callbackData === 'chart_type_donut') {
      state.chartType = 'donut';
      this.sessionStates.set(telegramUserId, state);
      await ctx.reply('✅ Donut chart selected. Now choose data grouping:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🪙 By Tokens', callback_data: 'chart_data_tokens' },
              { text: '💼 By Accounts', callback_data: 'chart_data_accounts' },
            ],
            [
              { text: '🏦 By Institutions', callback_data: 'chart_data_institutions' },
              { text: '📑 By Asset Type', callback_data: 'chart_data_types' },
            ],
            [{ text: '🔙 Back', callback_data: 'menu_charts' }],
          ],
        },
      });
      return;
    }

    if (callbackData === 'chart_type_bar') {
      state.chartType = 'bar';
      this.sessionStates.set(telegramUserId, state);
      await ctx.reply('✅ Bar chart selected. Now choose data grouping:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🪙 By Tokens', callback_data: 'chart_data_tokens' },
              { text: '💼 By Accounts', callback_data: 'chart_data_accounts' },
            ],
            [
              { text: '🏦 By Institutions', callback_data: 'chart_data_institutions' },
              { text: '📑 By Asset Type', callback_data: 'chart_data_types' },
            ],
            [{ text: '🔙 Back', callback_data: 'menu_charts' }],
          ],
        },
      });
      return;
    }

    // Handle data type selection
    if (callbackData.startsWith('chart_data_')) {
      const dataTypeMap: Record<string, 'tokens' | 'accounts' | 'institutions' | 'tokenTypes'> = {
        chart_data_tokens: 'tokens',
        chart_data_accounts: 'accounts',
        chart_data_institutions: 'institutions',
        chart_data_types: 'tokenTypes',
      };

      state.dataType = dataTypeMap[callbackData];

      // If chart type is set, generate chart immediately
      if (state.chartType && state.dataType) {
        await ctx.sendChatAction('upload_photo');

        const chartTypeText = state.chartType === 'donut' ? 'donut' : 'bar';
        const dataTypeText =
          state.dataType === 'tokens'
            ? 'tokens'
            : state.dataType === 'accounts'
              ? 'accounts'
              : state.dataType === 'institutions'
                ? 'institutions'
                : 'asset types';

        await this.delegateToAI(
          ctx,
          `Generate a ${chartTypeText} chart of my portfolio grouped by ${dataTypeText}`
        );

        // Clear state after generating
        this.sessionStates.delete(telegramUserId);
      } else {
        // Ask for chart type
        this.sessionStates.set(telegramUserId, state);
        await ctx.reply('✅ Data grouping selected. Now choose chart type:', {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🍩 Donut Chart', callback_data: 'chart_type_donut' },
                { text: '📊 Bar Chart', callback_data: 'chart_type_bar' },
              ],
              [{ text: '🔙 Back', callback_data: 'menu_charts' }],
            ],
          },
        });
      }
      return;
    }

    // Legacy chart callbacks (for backwards compatibility)
    if (callbackData === 'chart_donut' || callbackData === 'chart_bar') {
      const type = callbackData === 'chart_donut' ? 'donut' : 'bar';
      await this.delegateToAI(ctx, `Show me a ${type} chart of my portfolio`);
      return;
    }

    if (callbackData === 'chart_accounts') {
      await this.delegateToAI(ctx, 'Show me a chart of my portfolio grouped by accounts');
      return;
    }

    if (callbackData === 'chart_institutions') {
      await this.delegateToAI(ctx, 'Show me a chart of my portfolio grouped by institutions');
      return;
    }

    if (callbackData === 'chart_tokens') {
      await this.delegateToAI(ctx, 'Show me a chart of my top holdings grouped by token');
      return;
    }

    if (callbackData === 'chart_types') {
      await this.delegateToAI(ctx, 'Show me a chart of my asset allocation grouped by type');
      return;
    }
  }

  /**
   * Handle asset allocation callbacks
   */
  private async handleAllocationAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.reply(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    const dimensionMap: Record<string, string> = {
      allocation_token: 'Show my asset allocation by individual tokens',
      allocation_token_type: 'Show my asset allocation by token type (crypto, stocks, fiat)',
      allocation_account: 'Show my asset allocation by account',
      allocation_institution: 'Show my asset allocation by institution',
    };

    const query = dimensionMap[callbackData];
    if (query) {
      await this.delegateToAI(ctx, query);
    } else {
      await ctx.reply('❌ Unknown allocation type');
    }
  }

  /**
   * Handle settings actions
   */
  private async handleSettingsAction(ctx: BotContext, callbackData: string): Promise<void> {
    if (!ctx.userId) {
      await ctx.editMessageText(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    await ctx.sendChatAction('typing');

    switch (callbackData) {
      case 'settings_currency':
        await this.delegateToAI(ctx, 'What is my base currency and what currencies are available?');
        break;

      case 'settings_language':
        await ctx.reply(
          '🌐 <b>Language Settings</b>\n\n' +
            '<b>Current Language:</b> English (EN)\n\n' +
            '<b>Coming Soon!</b>\n' +
            'Multi-language support is under development.\n' +
            'We plan to support:\n' +
            '• Spanish (ES)\n' +
            '• French (FR)\n' +
            '• German (DE)\n' +
            '• And more!\n\n' +
            'Stay tuned! 🌍',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_settings' }]],
            },
          }
        );
        break;

      case 'settings_account':
        await ctx.reply(
          '🔐 <b>Account Status</b>\n\n' +
            '✅ <b>Authenticated</b>\n\n' +
            'Your Telegram account is linked to Scani.\n\n' +
            '<b>Quick Stats:</b>\n' +
            '• User ID: ' +
            ctx.userId.substring(0, 8) +
            '...\n' +
            '• Status: Active\n\n' +
            'Need to unlink? Visit the Scani web app Settings → Integrations.',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_settings' }]],
            },
          }
        );
        break;

      default:
        await ctx.reply('❌ Unknown settings action');
    }
  }

  /**
   * Handle general actions
   */
  private async handleGeneralAction(ctx: BotContext, callbackData: string): Promise<void> {
    switch (callbackData) {
      case 'action_help':
        await ctx.reply(
          '❓ <b>Need Help?</b>\n\n' +
            'Here are some helpful resources:\n\n' +
            '<b>Commands:</b>\n' +
            'Use /help to see all available commands\n\n' +
            '<b>Navigation:</b>\n' +
            'Use /menu for interactive menus\n\n' +
            '<b>Natural Language:</b>\n' +
            'Just chat with me! I understand natural requests.\n\n' +
            '<b>Examples:</b>\n' +
            '• "Show my portfolio"\n' +
            '• "Add 1 ETH to Coinbase"\n' +
            '• "What\'s the price of BTC?"\n' +
            '• "Import wallet 0x123..."\n\n' +
            'Still stuck? Try /reset to start fresh.',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]],
            },
          }
        );
        break;

      case 'action_ai_chat':
        await ctx.reply(
          '💬 <b>AI Chat Mode</b>\n\n' +
            "You're now in natural conversation mode!\n\n" +
            'Just chat with me normally. I can help you with:\n' +
            '• Portfolio analysis\n' +
            '• Adding/updating holdings\n' +
            '• Price checks\n' +
            '• Wallet imports\n' +
            '• And much more!\n\n' +
            '<b>Try asking:</b>\n' +
            '"What are my top 5 holdings?"\n' +
            '"How much Bitcoin do I have?"\n' +
            '"Add 100 shares of AAPL to my Robinhood account"\n\n' +
            'Use /menu anytime to return to guided navigation.',
          {
            parse_mode: 'HTML',
          }
        );
        break;

      case 'action_test_daily':
        if (!ctx.userId) {
          await ctx.reply(getAuthRequiredText(), { parse_mode: 'HTML' });
          return;
        }
        await ctx.sendChatAction('typing');
        await this.delegateToAI(
          ctx,
          'Generate my daily portfolio digest with price changes and market insights'
        );
        break;

      default:
        await ctx.reply('❌ Unknown action');
    }
  }

  /**
   * Delegate request to AI agent
   */
  private async delegateToAI(ctx: BotContext, query: string): Promise<void> {
    if (!ctx.userId || !ctx.telegramUserId) {
      await ctx.reply(getAuthRequiredText(), { parse_mode: 'HTML' });
      return;
    }

    try {
      // Get or create conversation context
      let conversationContext = this.conversationContexts.get(ctx.telegramUserId);
      if (!conversationContext) {
        conversationContext = {
          userId: ctx.userId,
          conversationHistory: [],
        };
        this.conversationContexts.set(ctx.telegramUserId, conversationContext);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Conversation context type is complex
      const context = conversationContext as any;
      context.userId = ctx.userId;

      await ctx.sendChatAction('typing');

      // Get AI response
      const response = await this.aiAgent.chat(query, context);

      // Check if response contains a chart
      const chartPattern = /\[CHART:([A-Za-z0-9+/=]+)\]/;
      const chartMatch = response.match(chartPattern);

      if (chartMatch?.[1]) {
        const chartBase64 = chartMatch[1];
        const chartBuffer = Buffer.from(chartBase64, 'base64');
        const caption = response.replace(chartPattern, '').trim();

        await ctx.sendChatAction('upload_photo');
        await ctx.replyWithPhoto(
          { source: chartBuffer },
          {
            caption: caption || 'Your portfolio chart',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]],
            },
          }
        );
      } else {
        // Convert markdown to HTML
        const htmlResponse = this.convertMarkdownToHTML(response);
        await ctx.reply(htmlResponse, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]],
          },
        });
      }

      // Update conversation history
      context.conversationHistory.push({
        role: 'user',
        content: query,
      });
      context.conversationHistory.push({
        role: 'assistant',
        content: response,
      });

      // Keep only last 20 messages
      if (context.conversationHistory.length > 20) {
        context.conversationHistory = context.conversationHistory.slice(-20);
      }
    } catch (error) {
      this.logger.error({ error, query }, 'Error delegating to AI');
      await ctx.reply(formatErrorMessage(error, 'AI Processing'), { parse_mode: 'HTML' });
    }
  }

  /**
   * Convert markdown to HTML (from bot.ts)
   */
  private convertMarkdownToHTML(markdown: string): string {
    let html = markdown;

    // Escape HTML
    const escapeHTML = (text: string): string => {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    // Convert markdown tables to HTML
    const tableRegex = /(\|.+\|[\r\n]+)+/g;
    html = html.replace(tableRegex, (table) => {
      const lines = table.trim().split('\n');
      if (lines.length < 2) return table;

      let htmlTable = '<pre>\n';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.match(/^\|[\s\-:]+\|$/)) continue;

        const cells = line
          .split('|')
          .slice(1, -1)
          .map((cell) => escapeHTML(cell.trim()));

        htmlTable += `${cells.join(' | ')}\n`;
      }
      htmlTable += '</pre>\n';
      return htmlTable;
    });

    // Convert bold, italic, code, links
    html = html.replace(/\*\*(.+?)\*\*/g, (_match, content) => `<b>${escapeHTML(content)}</b>`);
    html = html.replace(/__(.+?)__/g, (_match, content) => `<b>${escapeHTML(content)}</b>`);
    html = html.replace(
      /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
      (_match, content) => `<i>${escapeHTML(content)}</i>`
    );
    html = html.replace(
      /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
      (_match, content) => `<i>${escapeHTML(content)}</i>`
    );
    html = html.replace(/`(.+?)`/g, (_match, content) => `<code>${escapeHTML(content)}</code>`);
    html = html.replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_match, text, url) => `<a href="${escapeHTML(url)}">${escapeHTML(text)}</a>`
    );

    return html;
  }
}
