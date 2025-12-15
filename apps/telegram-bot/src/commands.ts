/**
 * Command Handlers for Telegram Bot
 * Organized command implementations for better maintainability
 */

import type { BotContext } from './bot';
import { getMainMenu } from './menus';

/**
 * Command definitions with descriptions for Telegram menu
 */
export const COMMANDS = [
  { command: 'start', description: 'Start the bot and see welcome message' },
  { command: 'menu', description: 'Show main menu with all features' },
  { command: 'dashboard', description: 'View portfolio dashboard' },
  { command: 'holdings', description: 'List all your holdings' },
  { command: 'accounts', description: 'View your accounts' },
  { command: 'institutions', description: 'Browse institutions' },
  { command: 'charts', description: 'View portfolio charts' },
  { command: 'daily', description: 'Get daily portfolio digest' },
  { command: 'help', description: 'Show help and available commands' },
  { command: 'auth', description: 'Link your Scani account' },
  { command: 'status', description: 'Check authentication status' },
  { command: 'settings', description: 'Configure preferences' },
  { command: 'reset', description: 'Reset conversation context' },
];

/**
 * Get help text with all commands
 */
export function getHelpText(): string {
  return (
    '📚 <b>Scani Finance Bot - Help</b>\n\n' +
    '<b>Quick Commands:</b>\n' +
    '/menu - Interactive menu (recommended)\n' +
    '/dashboard - Portfolio overview\n' +
    '/holdings - List all holdings\n' +
    '/accounts - View accounts\n' +
    '/institutions - Browse institutions\n' +
    '/charts - Portfolio charts\n' +
    '/daily - Daily digest\n\n' +
    '<b>Setup & Config:</b>\n' +
    '/start - Welcome message\n' +
    '/auth - Link your account\n' +
    '/status - Check auth status\n' +
    '/settings - Configure preferences\n' +
    '/reset - Reset conversation\n' +
    '/help - This help message\n\n' +
    '<b>Natural Language:</b>\n' +
    'Chat with me naturally! I understand:\n' +
    '• "Show my portfolio overview"\n' +
    '• "Add 0.5 BTC to my Coinbase account"\n' +
    '• "What are my top holdings?"\n' +
    '• "Import wallet 0x123..."\n' +
    '• "How much is ETH worth?"\n' +
    '• "Show my asset allocation"\n\n' +
    '<b>Screenshot Import:</b>\n' +
    "Send me a screenshot of your holdings and I'll import them!\n\n" +
    '<b>Need More Help?</b>\n' +
    'Use /menu for guided navigation through all features.'
  );
}

/**
 * Get welcome/start text
 */
export function getWelcomeText(isAuthenticated: boolean): string {
  if (isAuthenticated) {
    return (
      '👋 <b>Welcome back to Scani Finance!</b>\n\n' +
      'Your account is already linked and ready to go.\n\n' +
      'Use /menu to access all features, or simply chat with me naturally!\n\n' +
      '<b>Quick Actions:</b>\n' +
      '• /portfolio - View your portfolio\n' +
      '• /daily - Get daily digest\n' +
      '• /charts - See portfolio charts\n' +
      '• /help - View all commands'
    );
  }

  return (
    '👋 <b>Welcome to Scani Finance Bot!</b>\n\n' +
    'Your personal finance assistant that helps you:\n' +
    '• 💼 Track portfolio and holdings\n' +
    '• 📊 Visualize asset allocation\n' +
    '• 💰 Monitor price changes\n' +
    '• 📈 Analyze investments\n' +
    '• 🤖 Chat with AI for insights\n' +
    '• 📸 Import holdings from screenshots\n' +
    '• 💰 Import crypto wallets\n\n' +
    '<b>Getting Started:</b>\n' +
    '1. Link your Scani account: /auth\n' +
    '2. Explore features: /menu\n' +
    '3. Get help anytime: /help\n\n' +
    '<b>How to Authenticate:</b>\n' +
    'Get your auth token from the Scani web app:\n' +
    '1. Go to Settings → Integrations\n' +
    '2. Click "Connect Telegram"\n' +
    '3. Copy the generated token\n' +
    '4. Send: /auth YOUR_TOKEN\n\n' +
    "Let's get started! 🚀"
  );
}

/**
 * Get authentication required message
 */
export function getAuthRequiredText(): string {
  return (
    '🔐 <b>Authentication Required</b>\n\n' +
    'You need to link your Scani account to use this feature.\n\n' +
    '<b>How to authenticate:</b>\n' +
    '1. Open the Scani web app\n' +
    '2. Go to Settings → Integrations\n' +
    '3. Click "Connect Telegram"\n' +
    '4. Copy the generated token\n' +
    '5. Send it here: /auth YOUR_TOKEN\n\n' +
    'Need help? Use /help for more information.'
  );
}

/**
 * Handle /menu command - show main menu
 */
export async function handleMenuCommand(ctx: BotContext): Promise<void> {
  if (!ctx.userId) {
    await ctx.reply(getAuthRequiredText(), { parse_mode: 'HTML' });
    return;
  }

  const mainMenu = getMainMenu();
  await ctx.reply(mainMenu.text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: mainMenu.keyboard },
  });
}

/**
 * Handle /start command
 */
export async function handleStartCommand(ctx: BotContext): Promise<void> {
  const welcomeText = getWelcomeText(!!ctx.userId);
  const keyboard = [];

  // Add menu button if authenticated
  if (ctx.userId) {
    keyboard.push([{ text: '📱 Open Menu', callback_data: 'menu_main' }]);
  }

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    ...(keyboard.length > 0 && { reply_markup: { inline_keyboard: keyboard } }),
  });
}

/**
 * Handle /help command
 */
export async function handleHelpCommand(ctx: BotContext): Promise<void> {
  const helpText = getHelpText();
  await ctx.reply(helpText, { parse_mode: 'HTML' });
}

/**
 * Handle /status command
 */
export async function handleStatusCommand(ctx: BotContext): Promise<void> {
  if (ctx.userId) {
    await ctx.reply(
      '✅ <b>Authentication Status</b>\n\n' +
        'You are authenticated and ready to use the bot!\n\n' +
        '<b>Quick Start:</b>\n' +
        '• Use /menu for interactive navigation\n' +
        '• Or chat with me naturally!\n\n' +
        'Type /help to see all available commands.',
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(getAuthRequiredText(), { parse_mode: 'HTML' });
  }
}

/**
 * Handle /reset command
 */
export async function handleResetCommand(
  ctx: BotContext,
  conversationContexts: Map<string, unknown>
): Promise<void> {
  const telegramUserId = ctx.telegramUserId;
  if (telegramUserId) {
    conversationContexts.delete(telegramUserId);
    await ctx.reply(
      '🔄 <b>Conversation Reset</b>\n\n' +
        'Your conversation context has been cleared.\n\n' +
        'You can start fresh or use /menu to navigate features.',
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Format error message for users
 */
export function formatErrorMessage(error: unknown, context: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);

  return (
    `❌ <b>Error: ${context}</b>\n\n` +
    'Sorry, I encountered an issue:\n' +
    `<i>${errorMessage}</i>\n\n` +
    '<b>What you can try:</b>\n' +
    '• Use /reset to clear conversation\n' +
    '• Use /menu to navigate features\n' +
    '• Try the operation again\n' +
    '• Contact support if issue persists'
  );
}

/**
 * Format success message
 */
export function formatSuccessMessage(title: string, message: string): string {
  return `✅ <b>${title}</b>\n\n${message}`;
}

/**
 * Format info message
 */
export function formatInfoMessage(title: string, message: string): string {
  return `ℹ️ <b>${title}</b>\n\n${message}`;
}
