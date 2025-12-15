/**
 * Menu System for Telegram Bot
 * Provides inline keyboard menus for navigation and feature access
 */

import type { InlineKeyboardButton } from 'telegraf/types';

/**
 * Main menu - entry point for all features
 */
export function getMainMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '🏠 <b>Main Menu</b>\n\n' +
      'Welcome to Scani Finance Bot! Choose an option below:\n\n' +
      '📊 <b>Dashboard</b> - Portfolio overview and insights\n' +
      '🪙 <b>Holdings</b> - View and manage your holdings\n' +
      '🏦 <b>Accounts</b> - Manage financial accounts\n' +
      '🏢 <b>Institutions</b> - Browse institutions\n' +
      '📈 <b>Charts</b> - Visualize your portfolio\n' +
      '⚙️ <b>Settings</b> - Configure preferences',
    keyboard: [
      [
        { text: '📊 Dashboard', callback_data: 'menu_dashboard' },
        { text: '🪙 Holdings', callback_data: 'menu_holdings' },
      ],
      [
        { text: '🏦 Accounts', callback_data: 'menu_accounts' },
        { text: '🏢 Institutions', callback_data: 'menu_institutions' },
      ],
      [
        { text: '📈 Charts', callback_data: 'menu_charts' },
        { text: '⚙️ Settings', callback_data: 'menu_settings' },
      ],
      [
        { text: '💬 AI Chat Mode', callback_data: 'action_ai_chat' },
        { text: '❓ Help', callback_data: 'action_help' },
      ],
    ],
  };
}

/**
 * Dashboard submenu
 */
export function getDashboardMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '📊 <b>Dashboard</b>\n\n' +
      'Your portfolio overview and insights:\n\n' +
      '💼 <b>Overview</b> - Total value and summary\n' +
      '📈 <b>Asset Allocation</b> - Distribution analysis\n' +
      '🔝 <b>Top Holdings</b> - Your largest positions\n' +
      '💹 <b>Price Changes</b> - 24h market movements',
    keyboard: [
      [
        { text: '💼 Overview', callback_data: 'dashboard_overview' },
        { text: '📈 Allocation', callback_data: 'dashboard_allocation' },
      ],
      [
        { text: '🔝 Top Holdings', callback_data: 'dashboard_top' },
        { text: '💹 Price Changes', callback_data: 'dashboard_prices' },
      ],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Holdings submenu
 */
export function getHoldingsMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '🪙 <b>Holdings Management</b>\n\n' +
      'View and manage your investment holdings:\n\n' +
      '📋 <b>All Holdings</b> - View complete list\n' +
      '🔍 <b>Search</b> - Find specific holdings\n' +
      '➕ <b>Add</b> - Add new holdings\n' +
      '📸 <b>Screenshot</b> - Import from image\n' +
      '💰 <b>Wallet</b> - Import crypto wallet',
    keyboard: [
      [
        { text: '📋 All Holdings', callback_data: 'holdings_list' },
        { text: '🔍 Search', callback_data: 'holdings_search' },
      ],
      [
        { text: '➕ Add Holding', callback_data: 'holdings_add' },
        { text: '📸 Screenshot', callback_data: 'holdings_screenshot' },
      ],
      [{ text: '💰 Import Wallet', callback_data: 'holdings_wallet' }],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Accounts submenu
 */
export function getAccountsMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '🏦 <b>Account Management</b>\n\n' +
      'Manage your financial accounts:\n\n' +
      '📋 <b>All Accounts</b> - View all accounts\n' +
      '➕ <b>Add</b> - Create new account\n' +
      '🏢 <b>Institutions</b> - Browse institutions',
    keyboard: [
      [
        { text: '📋 All Accounts', callback_data: 'accounts_list' },
        { text: '➕ Add Account', callback_data: 'accounts_add' },
      ],
      [{ text: '🏢 Institutions', callback_data: 'accounts_institutions' }],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Institutions submenu
 */
export function getInstitutionsMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '🏢 <b>Institutions</b>\n\n' +
      'Browse and manage financial institutions:\n\n' +
      '📋 <b>All Institutions</b> - View complete list\n' +
      '💼 <b>My Institutions</b> - Institutions I use\n' +
      '📊 <b>Summary</b> - Values by institution\n' +
      '🏷️ <b>Types</b> - Browse by category',
    keyboard: [
      [
        { text: '📋 All Institutions', callback_data: 'institutions_all' },
        { text: '💼 My Institutions', callback_data: 'institutions_mine' },
      ],
      [
        { text: '📊 Summary', callback_data: 'institutions_summary' },
        { text: '🏷️ Types', callback_data: 'institutions_types' },
      ],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Chart type selection menu
 */
export function getChartMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '📈 <b>Portfolio Charts</b>\n\n' +
      'Visualize your portfolio distribution:\n\n' +
      '<b>Chart Types:</b>\n' +
      '🍩 Donut - Distribution overview\n' +
      '📊 Bar - Side-by-side comparison\n\n' +
      '<b>Group By:</b>\n' +
      '🪙 Tokens - Individual holdings\n' +
      '💼 Accounts - By account\n' +
      '🏦 Institutions - By institution\n' +
      '📑 Asset Types - Asset allocation',
    keyboard: [
      [
        { text: '🍩 Donut Chart', callback_data: 'chart_type_donut' },
        { text: '📊 Bar Chart', callback_data: 'chart_type_bar' },
      ],
      [
        { text: '🪙 By Tokens', callback_data: 'chart_data_tokens' },
        { text: '💼 By Accounts', callback_data: 'chart_data_accounts' },
      ],
      [
        { text: '🏦 By Institutions', callback_data: 'chart_data_institutions' },
        { text: '📑 By Asset Type', callback_data: 'chart_data_types' },
      ],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Settings submenu
 */
export function getSettingsMenu(): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text:
      '⚙️ <b>Settings</b>\n\n' +
      'Configure your preferences:\n\n' +
      '💱 <b>Currency</b> - Base currency setting\n' +
      '🌐 <b>Language</b> - Display language\n' +
      '🔐 <b>Account</b> - Authentication status',
    keyboard: [
      [
        { text: '💱 Currency', callback_data: 'settings_currency' },
        { text: '🌐 Language', callback_data: 'settings_language' },
      ],
      [{ text: '🔐 Account Status', callback_data: 'settings_account' }],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

/**
 * Pagination helper for lists
 */
export function getPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  callbackPrefix: string,
  backCallback: string
): InlineKeyboardButton[][] {
  const buttons: InlineKeyboardButton[][] = [];
  const navRow: InlineKeyboardButton[] = [];

  if (currentPage > 1) {
    navRow.push({
      text: '⬅️ Previous',
      callback_data: `${callbackPrefix}_page_${currentPage - 1}`,
    });
  }

  navRow.push({
    text: `📄 ${currentPage}/${totalPages}`,
    callback_data: 'page_info',
  });

  if (currentPage < totalPages) {
    navRow.push({
      text: 'Next ➡️',
      callback_data: `${callbackPrefix}_page_${currentPage + 1}`,
    });
  }

  buttons.push(navRow);
  buttons.push([{ text: '🔙 Back', callback_data: backCallback }]);

  return buttons;
}

/**
 * Confirmation dialog
 */
export function getConfirmationKeyboard(
  confirmCallback: string,
  cancelCallback: string
): InlineKeyboardButton[][] {
  return [
    [
      { text: '✅ Confirm', callback_data: confirmCallback },
      { text: '❌ Cancel', callback_data: cancelCallback },
    ],
  ];
}

/**
 * Time range selector for analytics
 */
export function getTimeRangeKeyboard(backCallback: string): InlineKeyboardButton[][] {
  return [
    [
      { text: '1D', callback_data: 'timerange_1d' },
      { text: '7D', callback_data: 'timerange_7d' },
      { text: '30D', callback_data: 'timerange_30d' },
    ],
    [
      { text: '90D', callback_data: 'timerange_90d' },
      { text: '1Y', callback_data: 'timerange_1y' },
      { text: 'All', callback_data: 'timerange_all' },
    ],
    [{ text: '🔙 Back', callback_data: backCallback }],
  ];
}
