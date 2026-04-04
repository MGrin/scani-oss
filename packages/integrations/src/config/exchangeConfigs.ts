/**
 * exchangeConfigs.ts
 *
 * Declarative configuration for all exchange integrations
 */

import { createBinanceApiService } from '../factories/binanceFactory';
import { createBitgetApiService } from '../factories/bitgetFactory';
import { createBitstampApiService } from '../factories/bitstampFactory';
import { createBybitApiService } from '../factories/bybitFactory';
import { createCoinbaseApiService } from '../factories/coinbaseFactory';
import { createGateioApiService } from '../factories/gateioFactory';
import { createGeminiApiService } from '../factories/geminiFactory';
import { createHuobiApiService } from '../factories/huobiFactory';
import { createIbkrFlexQueryService } from '../factories/ibkrFactory';
import { createKrakenApiService } from '../factories/krakenFactory';
import { createKucoinApiService } from '../factories/kucoinFactory';
import { createMexcApiService } from '../factories/mexcFactory';
import { createOkxApiService } from '../factories/okxFactory';
import { createWiseApiService } from '../factories/wiseFactory';
import { BinanceIntegration } from '../implementations/BinanceIntegration';
import { BitgetIntegration } from '../implementations/BitgetIntegration';
import { BitstampIntegration } from '../implementations/BitstampIntegration';
import { BybitIntegration } from '../implementations/BybitIntegration';
import { CoinbaseIntegration } from '../implementations/CoinbaseIntegration';
import { GateioIntegration } from '../implementations/GateioIntegration';
import { GeminiIntegration } from '../implementations/GeminiIntegration';
import { HuobiIntegration } from '../implementations/HuobiIntegration';
import { IbkrIntegration } from '../implementations/IbkrIntegration';
import { KrakenIntegration } from '../implementations/KrakenIntegration';
import { KucoinIntegration } from '../implementations/KucoinIntegration';
import { MexcIntegration } from '../implementations/MexcIntegration';
import { OkxIntegration } from '../implementations/OkxIntegration';
import { WiseIntegration } from '../implementations/WiseIntegration';
import { binanceRateLimiter } from '../rate-limiters/binance';
import { bitgetRateLimiter } from '../rate-limiters/bitget';
import { bitstampRateLimiter } from '../rate-limiters/bitstamp';
import { bybitRateLimiter } from '../rate-limiters/bybit';
import { coinbaseRateLimiter } from '../rate-limiters/coinbase';
import { gateioRateLimiter } from '../rate-limiters/gateio';
import { geminiRateLimiter } from '../rate-limiters/gemini';
import { huobiRateLimiter } from '../rate-limiters/huobi';
import { ibkrRateLimiter } from '../rate-limiters/ibkr';
import { krakenRateLimiter } from '../rate-limiters/kraken';
import { kucoinRateLimiter } from '../rate-limiters/kucoin';
import { mexcRateLimiter } from '../rate-limiters/mexc';
import { okxRateLimiter } from '../rate-limiters/okx';
import { wiseRateLimiter } from '../rate-limiters/wise';
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
 * Wise (TransferWise) configuration
 */
export const wiseConfig: IntegrationConfig = {
  institutionId: 'wise',
  type: 'payment',
  authType: 'api_key',
  name: 'Wise',
  createIntegration: () => {
    const WISE_API_BASE_URL = process.env.WISE_API_BASE_URL || 'https://api.wise.com';

    // Use factory function to create service - encapsulates implementation details
    const wiseService = createWiseApiService();

    // API Key authentication config - will be populated by user at runtime
    // Wise uses a Bearer token (API token) for authentication
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '', // Will be set by user through the form
      baseUrl: WISE_API_BASE_URL,
    };

    return new WiseIntegration('wise', authConfig, wiseService, wiseRateLimiter);
  },
  metadata: {
    website: 'https://wise.com',
    apiDocumentation: 'https://docs.wise.com/api-docs',
  },
};

/**
 * Bybit exchange configuration
 */
export const bybitConfig: IntegrationConfig = {
  institutionId: 'bybit',
  type: 'exchange',
  authType: 'api_key',
  name: 'Bybit',
  createIntegration: () => {
    const bybitService = createBybitApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bybit.com',
    };
    return new BybitIntegration('bybit', authConfig, bybitService, bybitRateLimiter);
  },
  metadata: {
    website: 'https://www.bybit.com',
    apiDocumentation: 'https://bybit-exchange.github.io/docs/',
  },
};

/**
 * OKX exchange configuration
 */
export const okxConfig: IntegrationConfig = {
  institutionId: 'okx',
  type: 'exchange',
  authType: 'api_key',
  name: 'OKX',
  createIntegration: () => {
    const okxService = createOkxApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://www.okx.com',
    };
    return new OkxIntegration('okx', authConfig, okxService, okxRateLimiter);
  },
  metadata: {
    website: 'https://www.okx.com',
    apiDocumentation: 'https://www.okx.com/docs-v5/',
  },
};

/**
 * Interactive Brokers configuration
 */
export const ibkrConfig: IntegrationConfig = {
  institutionId: 'ibkr',
  type: 'broker',
  authType: 'api_key',
  name: 'Interactive Brokers',
  createIntegration: () => {
    const ibkrService = createIbkrFlexQueryService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://ndcdyn.interactivebrokers.com',
    };
    return new IbkrIntegration('ibkr', authConfig, ibkrService, ibkrRateLimiter);
  },
  metadata: {
    website: 'https://www.interactivebrokers.com',
    apiDocumentation:
      'https://www.interactivebrokers.com/en/software/am/am/reports/activityflexqueries.htm',
  },
};

export const kucoinConfig: IntegrationConfig = {
  institutionId: 'kucoin',
  type: 'exchange',
  authType: 'api_key',
  name: 'KuCoin',
  createIntegration: () => {
    const service = createKucoinApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.kucoin.com',
    };
    return new KucoinIntegration('kucoin', authConfig, service, kucoinRateLimiter);
  },
  metadata: { website: 'https://www.kucoin.com' },
};

export const gateioConfig: IntegrationConfig = {
  institutionId: 'gateio',
  type: 'exchange',
  authType: 'api_key',
  name: 'Gate.io',
  createIntegration: () => {
    const service = createGateioApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.gateio.ws',
    };
    return new GateioIntegration('gateio', authConfig, service, gateioRateLimiter);
  },
  metadata: { website: 'https://www.gate.io' },
};

export const coinbaseConfig: IntegrationConfig = {
  institutionId: 'coinbase',
  type: 'exchange',
  authType: 'api_key',
  name: 'Coinbase',
  createIntegration: () => {
    const service = createCoinbaseApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.coinbase.com',
    };
    return new CoinbaseIntegration('coinbase', authConfig, service, coinbaseRateLimiter);
  },
  metadata: { website: 'https://www.coinbase.com' },
};

export const bitstampConfig: IntegrationConfig = {
  institutionId: 'bitstamp',
  type: 'exchange',
  authType: 'api_key',
  name: 'Bitstamp',
  createIntegration: () => {
    const service = createBitstampApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://www.bitstamp.net',
    };
    return new BitstampIntegration('bitstamp', authConfig, service, bitstampRateLimiter);
  },
  metadata: { website: 'https://www.bitstamp.net' },
};

export const geminiConfig: IntegrationConfig = {
  institutionId: 'gemini',
  type: 'exchange',
  authType: 'api_key',
  name: 'Gemini',
  createIntegration: () => {
    const service = createGeminiApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.gemini.com',
    };
    return new GeminiIntegration('gemini', authConfig, service, geminiRateLimiter);
  },
  metadata: { website: 'https://www.gemini.com' },
};

export const mexcConfig: IntegrationConfig = {
  institutionId: 'mexc',
  type: 'exchange',
  authType: 'api_key',
  name: 'MEXC',
  createIntegration: () => {
    const service = createMexcApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.mexc.com',
    };
    return new MexcIntegration('mexc', authConfig, service, mexcRateLimiter);
  },
  metadata: { website: 'https://www.mexc.com' },
};

export const bitgetConfig: IntegrationConfig = {
  institutionId: 'bitget',
  type: 'exchange',
  authType: 'api_key',
  name: 'Bitget',
  createIntegration: () => {
    const service = createBitgetApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bitget.com',
    };
    return new BitgetIntegration('bitget', authConfig, service, bitgetRateLimiter);
  },
  metadata: { website: 'https://www.bitget.com' },
};

export const huobiConfig: IntegrationConfig = {
  institutionId: 'huobi',
  type: 'exchange',
  authType: 'api_key',
  name: 'Huobi',
  createIntegration: () => {
    const service = createHuobiApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.huobi.pro',
    };
    return new HuobiIntegration('huobi', authConfig, service, huobiRateLimiter);
  },
  metadata: { website: 'https://www.huobi.com' },
};

/**
 * All exchange/service integrations
 * Adding a new exchange here automatically registers it for cron sync
 * via IntegrationManager and SyncExchangeBalancesUseCase auto-discovery.
 */
export const exchangeConfigs: IntegrationConfig[] = [
  binanceConfig,
  krakenConfig,
  wiseConfig,
  bybitConfig,
  okxConfig,
  ibkrConfig,
  kucoinConfig,
  gateioConfig,
  coinbaseConfig,
  bitstampConfig,
  geminiConfig,
  mexcConfig,
  bitgetConfig,
  huobiConfig,
];
