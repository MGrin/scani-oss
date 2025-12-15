/**
 * exchangeConfigs.ts
 *
 * Declarative configuration for all exchange integrations
 */

import { createBinanceApiService } from '../factories/binanceFactory';
import { createKrakenApiService } from '../factories/krakenFactory';
import { BinanceIntegration } from '../implementations/BinanceIntegration';
import { KrakenIntegration } from '../implementations/KrakenIntegration';
import { binanceRateLimiter } from '../rate-limiters/binance';
import { krakenRateLimiter } from '../rate-limiters/kraken';
import type { IntegrationConfig } from '../registry/IntegrationRegistry';
import { IntegrationAuthType } from '../types';

/**
 * Binance exchange configuration
 */
export const binanceConfig: IntegrationConfig = {
  institutionId: 'binance',
  type: 'exchange',
  authType: 'api_key',
  name: 'Binance',
  createIntegration: () => {
    const BINANCE_API_BASE_URL = process.env.BINANCE_API_BASE_URL || 'https://api.binance.com';

    // Use factory function to create service - encapsulates implementation details
    const binanceService = createBinanceApiService();

    // API Key authentication config - will be populated by user at runtime
    // For now, we provide a placeholder config that will be replaced with actual credentials
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '', // Will be set by user through the form
      baseUrl: BINANCE_API_BASE_URL,
    };

    return new BinanceIntegration('binance', authConfig, binanceService, binanceRateLimiter);
  },
  metadata: {
    website: 'https://www.binance.com',
    apiDocumentation: 'https://binance-docs.github.io/apidocs/',
  },
};

/**
 * Kraken exchange configuration
 */
export const krakenConfig: IntegrationConfig = {
  institutionId: 'kraken',
  type: 'exchange',
  authType: 'api_key',
  name: 'Kraken',
  createIntegration: () => {
    const KRAKEN_API_BASE_URL = process.env.KRAKEN_API_BASE_URL || 'https://api.kraken.com';

    // Use factory function to create service - encapsulates implementation details
    const krakenService = createKrakenApiService();

    // API Key authentication config - will be populated by user at runtime
    // For now, we provide a placeholder config that will be replaced with actual credentials
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '', // Will be set by user through the form
      baseUrl: KRAKEN_API_BASE_URL,
    };

    return new KrakenIntegration('kraken', authConfig, krakenService, krakenRateLimiter);
  },
  metadata: {
    website: 'https://www.kraken.com',
    apiDocumentation: 'https://docs.kraken.com/api/',
  },
};

/**
 * All exchange integrations
 */
export const exchangeConfigs: IntegrationConfig[] = [
  binanceConfig,
  krakenConfig,
  // Future exchanges can be added here:
  // coinbaseConfig,
  // uniswap,
  // etc.
];
