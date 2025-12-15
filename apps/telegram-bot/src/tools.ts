import { ALL_FEATURES, getFeatureCategorySummary } from '@scani/core/features';
import { z } from 'zod';

/**
 * Tool definitions for the AI agent
 * These tools allow the AI to interact with the tRPC backend
 *
 * This module now generates tools dynamically from the feature registry
 * to ensure alignment with UI functionality.
 */

/**
 * Generate tools from feature registry
 * Maps features to tool definitions compatible with the AI agent
 */
function generateToolsFromFeatures() {
  // biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamically typed based on feature schemas
  const tools: Record<string, { description: string; parameters: z.ZodType<any> }> = {};

  for (const feature of ALL_FEATURES) {
    // Convert feature ID to tool name (e.g., "dashboard.getOverview" -> "getDashboardOverview")
    const toolName = featureIdToToolName(feature.id);

    tools[toolName] = {
      description: feature.description,
      parameters: feature.inputSchema,
    };
  }

  // Add special tools that don't map directly to features

  // Portfolio Analysis Tools
  tools.getPortfolioByTokens = {
    description:
      'Get portfolio breakdown grouped by individual tokens (e.g., BTC, ETH, AAPL). Shows each token with total balance across all accounts, current value, and percentage. Use for creating donut or bar charts by token, or when user asks about their holdings by token.',
    parameters: z.object({}),
  };

  tools.getPortfolioByAccounts = {
    description:
      'Get portfolio breakdown grouped by accounts (e.g., "Coinbase", "Robinhood", "Checking Account"). Shows each account with total value and percentage. Use for creating donut or bar charts by account, or when user asks about distribution across accounts.',
    parameters: z.object({}),
  };

  tools.getPortfolioByInstitutions = {
    description:
      'Get portfolio breakdown grouped by institutions (e.g., "Coinbase", "Chase", "Vanguard"). Shows each institution with total value and percentage. Use for creating donut or bar charts by institution, or when user asks about distribution across institutions.',
    parameters: z.object({}),
  };

  tools.getPortfolioByTokenTypes = {
    description:
      'Get portfolio breakdown grouped by token types (e.g., "Cryptocurrency", "Stock", "Fiat"). Shows asset allocation with value and percentage for each type. Use for creating donut or bar charts by asset type, or when user asks about asset allocation.',
    parameters: z.object({}),
  };

  // Chart Generation Tool
  tools.generatePortfolioChart = {
    description:
      'Generate a visual chart image for portfolio data. Creates donut charts for distribution (tokens, accounts, institutions, asset types) or bar charts for comparisons. Returns an image that can be sent to the user. Use when user asks for a chart, graph, or visual representation of their portfolio. ALWAYS use this when visualizations would help explain data.',
    parameters: z.object({
      chartType: z
        .enum(['donut', 'bar'])
        .describe('Type of chart: donut for distribution, bar for comparisons'),
      dataType: z
        .enum(['tokens', 'accounts', 'institutions', 'tokenTypes'])
        .describe(
          'What to chart: tokens (individual holdings), accounts, institutions, or tokenTypes (asset allocation)'
        ),
    }),
  };

  // Price Movement Tool
  tools.get24hPriceChanges = {
    description:
      'Get 24-hour price changes for all tokens in the user portfolio. Returns the top price changes (both gainers and losers) with percentage changes and absolute value changes. Use this for daily digest or when user asks about recent price movements. CRITICAL for understanding portfolio volatility.',
    parameters: z.object({
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of top movers to return (default: 10)'),
    }),
  };

  // Analysis & Insights Tools (NEW)
  tools.analyzePortfolioDiversification = {
    description:
      'Analyze portfolio diversification across token types, accounts, and institutions. Returns diversification score, concentration risks, and recommendations. Use when user asks about portfolio risk, diversification, or balance.',
    parameters: z.object({}),
  };

  tools.compareHoldings = {
    description:
      'Compare two or more holdings side-by-side with their values, percentages of portfolio, and performance. Useful for "compare X vs Y" queries or when user wants to see relative positions.',
    parameters: z.object({
      tokenSymbols: z
        .array(z.string())
        .min(2)
        .max(5)
        .describe('Token symbols to compare (e.g., ["BTC", "ETH", "AAPL"])'),
    }),
  };

  tools.suggestRebalancing = {
    description:
      'Analyze current portfolio allocation and suggest rebalancing opportunities based on concentration risks and diversification principles. Use when user asks "what should I do" or "how to improve portfolio".',
    parameters: z.object({}),
  };

  tools.calculatePortfolioMetrics = {
    description:
      'Calculate key portfolio metrics: total value, total holdings count, number of accounts, asset type distribution, top 5 holdings concentration percentage. Use for comprehensive portfolio analysis.',
    parameters: z.object({}),
  };

  tools.findLargestHoldings = {
    description:
      'Find the largest holdings by value with detailed information. Returns top N holdings sorted by value. Use when user asks about "biggest holdings", "largest positions", or "top investments".',
    parameters: z.object({
      limit: z.number().optional().default(10).describe('Number of top holdings to return'),
    }),
  };

  tools.findSmallestHoldings = {
    description:
      'Find the smallest holdings by value. Useful for identifying dust holdings or positions to clean up. Use when user asks about "small holdings", "dust", or "cleanup".',
    parameters: z.object({
      limit: z.number().optional().default(10).describe('Number of smallest holdings to return'),
    }),
  };

  tools.searchTokensByType = {
    description:
      'Search for tokens filtered by type (cryptocurrency, stock, fiat, etc.). Returns matching tokens with pricing data. Use when user wants to explore specific asset classes or add holdings of a certain type.',
    parameters: z.object({
      tokenType: z
        .string()
        .describe('Token type to filter by (e.g., "cryptocurrency", "stock", "fiat")'),
      limit: z.number().optional().default(20).describe('Maximum results to return'),
    }),
  };

  tools.getAccountSummary = {
    description:
      'Get detailed summary for a specific account including all holdings, total value, asset distribution, and recent changes. Use when user asks about a specific account in detail.',
    parameters: z.object({
      accountId: z.string().uuid().describe('UUID of the account to analyze'),
    }),
  };

  tools.explainHolding = {
    description:
      'Get comprehensive explanation of a specific holding including: token information, current price, quantity held, total value, percentage of portfolio, which account it\'s in, and performance insights. Use when user asks "tell me about [symbol]" or wants detailed holding information.',
    parameters: z.object({
      tokenSymbol: z.string().describe('Token symbol (e.g., BTC, AAPL, USD)'),
    }),
  };

  return tools;
}

/**
 * Convert feature ID to tool name
 * E.g., "dashboard.getOverview" -> "getDashboardOverview"
 * E.g., "accounts.delete" -> "deleteAccountsDelete"
 * E.g., "wallet.detectChains" -> "detectWalletChains"
 */
function featureIdToToolName(featureId: string): string {
  const parts = featureId.split('.');
  if (parts.length === 1) return featureId;

  const category = parts[0] as string; // parts[0] is guaranteed to exist after length check
  const action = parts.slice(1).join('');

  // Capitalize the category
  const capitalizedCategory = category.charAt(0).toUpperCase() + category.slice(1);

  // Capitalize the action
  const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1);

  // Extract verb from action (get, update, delete, create, import, detect, search, list)
  const verbs = ['get', 'update', 'delete', 'create', 'import', 'detect', 'search', 'list'];
  let verb = '';
  let restOfAction = '';

  for (const v of verbs) {
    if (action.toLowerCase().startsWith(v)) {
      verb = v;
      restOfAction = capitalizedAction.substring(v.length);
      break;
    }
  }

  // If no verb found, default to 'get' and use full action
  if (!verb) {
    verb = 'get';
    restOfAction = capitalizedAction;
  }

  // Build tool name: verb + Category + RestOfAction
  // Special case: if action is JUST the verb (e.g., "delete", "update"), keep it
  // This creates patterns like deleteAccountsDelete, updateHoldingsUpdate
  if (restOfAction === '') {
    restOfAction = capitalizedAction;
  }

  return verb + capitalizedCategory + restOfAction;
}

/**
 * Get list of available tools organized by category
 * Used for the /tools command
 */
export function getToolsList(): string {
  const summary = getFeatureCategorySummary();

  let output = '🛠️ **Available Tools**\n\n';
  output += `Total: ${ALL_FEATURES.length} tools across ${summary.length} categories\n\n`;

  for (const { category, count, features } of summary) {
    const categoryName = category
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    output += `**${categoryName}** (${count} tools)\n`;

    for (const feature of features) {
      const toolName = featureIdToToolName(feature.id);
      output += `  • \`${toolName}\` - ${feature.name}\n`;
    }
    output += '\n';
  }

  // Add special tools
  output += '**Portfolio Analysis Tools** (6 tools)\n';
  output += '  • `getPortfolioByTokens` - Portfolio breakdown by tokens\n';
  output += '  • `getPortfolioByAccounts` - Portfolio breakdown by accounts\n';
  output += '  • `getPortfolioByInstitutions` - Portfolio breakdown by institutions\n';
  output += '  • `getPortfolioByTokenTypes` - Portfolio breakdown by token types\n';
  output += '  • `generatePortfolioChart` - Generate visual charts\n';
  output += '  • `get24hPriceChanges` - 24-hour price movements\n\n';

  output += '**AI Analysis & Insights** (9 tools)\n';
  output += '  • `analyzePortfolioDiversification` - Analyze diversification and risks\n';
  output += '  • `compareHoldings` - Compare holdings side-by-side\n';
  output += '  • `suggestRebalancing` - Get rebalancing suggestions\n';
  output += '  • `calculatePortfolioMetrics` - Calculate key metrics\n';
  output += '  • `findLargestHoldings` - Find top holdings by value\n';
  output += '  • `findSmallestHoldings` - Find smallest holdings\n';
  output += '  • `searchTokensByType` - Search tokens by asset type\n';
  output += '  • `getAccountSummary` - Get detailed account summary\n';
  output += '  • `explainHolding` - Comprehensive holding explanation\n';

  return output;
}

export const tools = generateToolsFromFeatures();

export type ToolName = keyof typeof tools;
