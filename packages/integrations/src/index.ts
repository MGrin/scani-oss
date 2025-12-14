/**
 * @scani/integrations
 *
 * Institution integration framework for Scani Finance
 *
 * This package provides the foundation for integrating with various financial
 * institutions including:
 * - Cryptocurrency exchanges (OAuth 2.0)
 * - Blockchain networks (RPC)
 * - Traditional brokers (API keys)
 * - Manual entry
 *
 * @example
 * ```typescript
 * import { ScaniIntegration, IntegrationAuthType } from '@scani/integrations';
 *
 * class BinanceIntegration extends ScaniIntegration {
 *   constructor(institutionId: string) {
 *     super(institutionId, {
 *       type: IntegrationAuthType.OAUTH,
 *       clientId: process.env.BINANCE_CLIENT_ID,
 *       clientSecret: process.env.BINANCE_CLIENT_SECRET,
 *       tokenEndpoint: 'https://api.binance.com/oauth/token',
 *       authorizationEndpoint: 'https://api.binance.com/oauth/authorize',
 *       scopes: ['read:accounts', 'read:balances'],
 *     });
 *   }
 *
 *   async fetchAccounts(credentials) {
 *     // Implementation
 *   }
 *
 *   async fetchHoldings(accountId, credentials) {
 *     // Implementation
 *   }
 *
 *   async mapToken(holding) {
 *     // Implementation
 *   }
 * }
 * ```
 */

export { ScaniIntegration } from './base';
export { allIntegrationConfigs, exchangeConfigs } from './config/integrationConfigs';
// Export factory functions
export {
  createBinanceApiService,
  detectBinanceAccountTypes,
  validateBinanceCredentials,
} from './factories/binanceFactory';
export { IntegrationManager } from './IntegrationManager';
// Export blockchain integration implementations
export * from './implementations';
// Export registry and configuration
export {
  type IntegrationConfig,
  type IntegrationType,
  integrationRegistry,
} from './registry/IntegrationRegistry';
export * from './types';
