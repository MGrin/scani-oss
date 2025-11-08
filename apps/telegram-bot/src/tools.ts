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

  tools.generatePortfolioChart = {
    description:
      'Generate a visual chart image for portfolio data. Creates donut charts for distribution (tokens, accounts, institutions, asset types) or bar charts for comparisons. Returns an image that can be sent to the user. Use when user asks for a chart, graph, or visual representation of their portfolio.',
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

  tools.get24hPriceChanges = {
    description:
      'Get 24-hour price changes for all tokens in the user portfolio. Returns the top price changes (both gainers and losers) with percentage changes and absolute value changes. Use this for daily digest or when user asks about recent price movements.',
    parameters: z.object({
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of top movers to return (default: 10)'),
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
  output += '**Special Tools** (3 tools)\n';
  output += '  • `getPortfolioByTokens` - Portfolio breakdown by tokens\n';
  output += '  • `getPortfolioByAccounts` - Portfolio breakdown by accounts\n';
  output += '  • `getPortfolioByInstitutions` - Portfolio breakdown by institutions\n';
  output += '  • `getPortfolioByTokenTypes` - Portfolio breakdown by token types\n';
  output += '  • `generatePortfolioChart` - Generate visual chart\n';
  output += '  • `get24hPriceChanges` - 24-hour price movements\n';

  return output;
}

export const tools = generateToolsFromFeatures();

export type ToolName = keyof typeof tools;
