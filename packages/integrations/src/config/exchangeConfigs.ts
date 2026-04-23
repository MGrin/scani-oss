/**
 * exchangeConfigs.ts
 *
 * Declarative configuration for all exchange integrations
 */

import { createAlpacaApiService } from '../factories/alpacaFactory';
import { createBinanceApiService } from '../factories/binanceFactory';
import { createBitbankApiService } from '../factories/bitbankFactory';
import { createBitfinexApiService } from '../factories/bitfinexFactory';
import { createBitflyerApiService } from '../factories/bitflyerFactory';
import { createBitgetApiService } from '../factories/bitgetFactory';
import { createBitpandaApiService } from '../factories/bitpandaFactory';
import { createBitstampApiService } from '../factories/bitstampFactory';
import { createBrexApiService } from '../factories/brexFactory';
import { createBtcMarketsApiService } from '../factories/btcMarketsFactory';
import { createBybitApiService } from '../factories/bybitFactory';
import { createCoinbaseApiService } from '../factories/coinbaseFactory';
import { createCoincheckApiService } from '../factories/coincheckFactory';
import { createGateioApiService } from '../factories/gateioFactory';
import { createGeminiApiService } from '../factories/geminiFactory';
import { createHuobiApiService } from '../factories/huobiFactory';
import { createIbkrFlexQueryService } from '../factories/ibkrFactory';
import { createIndependentReserveApiService } from '../factories/independentReserveFactory';
import { createKrakenApiService } from '../factories/krakenFactory';
import { createKucoinApiService } from '../factories/kucoinFactory';
import { createMercuryApiService } from '../factories/mercuryFactory';
import { createMexcApiService } from '../factories/mexcFactory';
import { createOkxApiService } from '../factories/okxFactory';
import { createTigerApiService } from '../factories/tigerFactory';
import { createTinkoffApiService } from '../factories/tinkoffFactory';
import { createWiseApiService } from '../factories/wiseFactory';
import { createZerodhaApiService } from '../factories/zerodhaFactory';
import { AlpacaIntegration } from '../implementations/AlpacaIntegration';
import { BinanceIntegration } from '../implementations/BinanceIntegration';
import { BitbankIntegration } from '../implementations/BitbankIntegration';
import { BitfinexIntegration } from '../implementations/BitfinexIntegration';
import { BitflyerIntegration } from '../implementations/BitflyerIntegration';
import { BitgetIntegration } from '../implementations/BitgetIntegration';
import { BitpandaIntegration } from '../implementations/BitpandaIntegration';
import { BitstampIntegration } from '../implementations/BitstampIntegration';
import { BrexIntegration } from '../implementations/BrexIntegration';
import { BtcMarketsIntegration } from '../implementations/BtcMarketsIntegration';
import { BybitIntegration } from '../implementations/BybitIntegration';
import { CoinbaseIntegration } from '../implementations/CoinbaseIntegration';
import { CoincheckIntegration } from '../implementations/CoincheckIntegration';
import { GateioIntegration } from '../implementations/GateioIntegration';
import { GeminiIntegration } from '../implementations/GeminiIntegration';
import { HuobiIntegration } from '../implementations/HuobiIntegration';
import { IbkrIntegration } from '../implementations/IbkrIntegration';
import { IndependentReserveIntegration } from '../implementations/IndependentReserveIntegration';
import { KrakenIntegration } from '../implementations/KrakenIntegration';
import { KucoinIntegration } from '../implementations/KucoinIntegration';
import { MercuryIntegration } from '../implementations/MercuryIntegration';
import { MexcIntegration } from '../implementations/MexcIntegration';
import { OkxIntegration } from '../implementations/OkxIntegration';
import { TigerIntegration } from '../implementations/TigerIntegration';
import { TinkoffIntegration } from '../implementations/TinkoffIntegration';
import { WiseIntegration } from '../implementations/WiseIntegration';
import { ZerodhaIntegration } from '../implementations/ZerodhaIntegration';
import { alpacaRateLimiter } from '../rate-limiters/alpaca';
import { binanceRateLimiter } from '../rate-limiters/binance';
import { bitbankRateLimiter } from '../rate-limiters/bitbank';
import { bitfinexRateLimiter } from '../rate-limiters/bitfinex';
import { bitflyerRateLimiter } from '../rate-limiters/bitflyer';
import { bitgetRateLimiter } from '../rate-limiters/bitget';
import { bitpandaRateLimiter } from '../rate-limiters/bitpanda';
import { bitstampRateLimiter } from '../rate-limiters/bitstamp';
import { brexRateLimiter } from '../rate-limiters/brex';
import { btcMarketsRateLimiter } from '../rate-limiters/btcMarkets';
import { bybitRateLimiter } from '../rate-limiters/bybit';
import { coinbaseRateLimiter } from '../rate-limiters/coinbase';
import { coincheckRateLimiter } from '../rate-limiters/coincheck';
import { gateioRateLimiter } from '../rate-limiters/gateio';
import { geminiRateLimiter } from '../rate-limiters/gemini';
import { huobiRateLimiter } from '../rate-limiters/huobi';
import { ibkrRateLimiter } from '../rate-limiters/ibkr';
import { independentReserveRateLimiter } from '../rate-limiters/independentReserve';
import { krakenRateLimiter } from '../rate-limiters/kraken';
import { kucoinRateLimiter } from '../rate-limiters/kucoin';
import { mercuryRateLimiter } from '../rate-limiters/mercury';
import { mexcRateLimiter } from '../rate-limiters/mexc';
import { okxRateLimiter } from '../rate-limiters/okx';
import { tigerRateLimiter } from '../rate-limiters/tiger';
import { tinkoffRateLimiter } from '../rate-limiters/tinkoff';
import { wiseRateLimiter } from '../rate-limiters/wise';
import { zerodhaRateLimiter } from '../rate-limiters/zerodha';
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

export const independentReserveConfig: IntegrationConfig = {
  institutionId: 'independent_reserve',
  type: 'exchange',
  authType: 'api_key',
  name: 'Independent Reserve',
  createIntegration: () => {
    const service = createIndependentReserveApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.independentreserve.com',
    };
    return new IndependentReserveIntegration(
      'independent_reserve',
      authConfig,
      service,
      independentReserveRateLimiter
    );
  },
  metadata: {
    website: 'https://www.independentreserve.com',
    apiDocumentation: 'https://www.independentreserve.com/features/api',
  },
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

export const btcMarketsConfig: IntegrationConfig = {
  institutionId: 'btc_markets',
  type: 'exchange',
  authType: 'api_key',
  name: 'BTC Markets',
  createIntegration: () => {
    const service = createBtcMarketsApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.btcmarkets.net',
    };
    return new BtcMarketsIntegration('btc_markets', authConfig, service, btcMarketsRateLimiter);
  },
  metadata: {
    website: 'https://www.btcmarkets.net',
    apiDocumentation: 'https://docs.btcmarkets.net/',
  },
};

export const bitfinexConfig: IntegrationConfig = {
  institutionId: 'bitfinex',
  type: 'exchange',
  authType: 'api_key',
  name: 'Bitfinex',
  createIntegration: () => {
    const service = createBitfinexApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bitfinex.com',
    };
    return new BitfinexIntegration('bitfinex', authConfig, service, bitfinexRateLimiter);
  },
  metadata: {
    website: 'https://www.bitfinex.com',
    apiDocumentation: 'https://docs.bitfinex.com/docs/rest-auth',
  },
};

export const bitpandaConfig: IntegrationConfig = {
  institutionId: 'bitpanda',
  type: 'exchange',
  authType: 'api_key',
  name: 'Bitpanda',
  createIntegration: () => {
    const service = createBitpandaApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bitpanda.com',
    };
    return new BitpandaIntegration('bitpanda', authConfig, service, bitpandaRateLimiter);
  },
  metadata: {
    website: 'https://www.bitpanda.com',
    apiDocumentation: 'https://developers.bitpanda.com/',
  },
};

export const bitflyerConfig: IntegrationConfig = {
  institutionId: 'bitflyer',
  type: 'exchange',
  authType: 'api_key',
  name: 'bitFlyer',
  createIntegration: () => {
    const service = createBitflyerApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bitflyer.com',
    };
    return new BitflyerIntegration('bitflyer', authConfig, service, bitflyerRateLimiter);
  },
  metadata: {
    website: 'https://bitflyer.com',
    apiDocumentation: 'https://lightning.bitflyer.com/docs?lang=en',
  },
};

export const coincheckConfig: IntegrationConfig = {
  institutionId: 'coincheck',
  type: 'exchange',
  authType: 'api_key',
  name: 'Coincheck',
  createIntegration: () => {
    const service = createCoincheckApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://coincheck.com',
    };
    return new CoincheckIntegration('coincheck', authConfig, service, coincheckRateLimiter);
  },
  metadata: {
    website: 'https://coincheck.com',
    apiDocumentation: 'https://coincheck.com/documents/exchange/api',
  },
};

export const bitbankConfig: IntegrationConfig = {
  institutionId: 'bitbank',
  type: 'exchange',
  authType: 'api_key',
  name: 'bitbank',
  createIntegration: () => {
    const service = createBitbankApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.bitbank.cc',
    };
    return new BitbankIntegration('bitbank', authConfig, service, bitbankRateLimiter);
  },
  metadata: {
    website: 'https://bitbank.cc',
    apiDocumentation: 'https://github.com/bitbankinc/bitbank-api-docs',
  },
};

export const alpacaConfig: IntegrationConfig = {
  institutionId: 'alpaca',
  type: 'broker',
  authType: 'api_key',
  name: 'Alpaca',
  createIntegration: () => {
    const service = createAlpacaApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.alpaca.markets',
    };
    return new AlpacaIntegration('alpaca', authConfig, service, alpacaRateLimiter);
  },
  metadata: {
    website: 'https://alpaca.markets',
    apiDocumentation: 'https://docs.alpaca.markets/',
  },
};

export const tinkoffConfig: IntegrationConfig = {
  institutionId: 'tinkoff',
  type: 'broker',
  authType: 'api_key',
  name: 'T-Bank (Tinkoff)',
  createIntegration: () => {
    const service = createTinkoffApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://invest-public-api.tinkoff.ru',
    };
    return new TinkoffIntegration('tinkoff', authConfig, service, tinkoffRateLimiter);
  },
  metadata: {
    website: 'https://www.tbank.ru/invest/',
    apiDocumentation: 'https://tinkoff.github.io/investAPI/',
  },
};

export const tigerConfig: IntegrationConfig = {
  institutionId: 'tiger_brokers',
  type: 'broker',
  authType: 'api_key',
  name: 'Tiger Brokers',
  createIntegration: () => {
    const service = createTigerApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://openapi.tigerfintech.com',
    };
    return new TigerIntegration('tiger_brokers', authConfig, service, tigerRateLimiter);
  },
  metadata: {
    website: 'https://www.tigerbrokers.com',
    apiDocumentation: 'https://quant.itigerup.com/openapi/en/',
  },
};

export const zerodhaConfig: IntegrationConfig = {
  institutionId: 'zerodha',
  type: 'broker',
  authType: 'api_key',
  name: 'Zerodha',
  createIntegration: () => {
    const service = createZerodhaApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://api.kite.trade',
    };
    return new ZerodhaIntegration('zerodha', authConfig, service, zerodhaRateLimiter);
  },
  metadata: {
    website: 'https://zerodha.com',
    apiDocumentation: 'https://kite.trade/docs/connect/v3/',
  },
};

export const mercuryConfig: IntegrationConfig = {
  institutionId: 'mercury',
  type: 'payment',
  authType: 'api_key',
  name: 'Mercury',
  createIntegration: () => {
    const service = createMercuryApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://backend.mercury.com/api/v1',
    };
    return new MercuryIntegration('mercury', authConfig, service, mercuryRateLimiter);
  },
  metadata: {
    website: 'https://mercury.com',
    apiDocumentation: 'https://docs.mercury.com/',
  },
};

export const brexConfig: IntegrationConfig = {
  institutionId: 'brex',
  type: 'payment',
  authType: 'api_key',
  name: 'Brex',
  createIntegration: () => {
    const service = createBrexApiService();
    const authConfig = {
      type: IntegrationAuthType.API_KEY as const,
      apiKey: '',
      baseUrl: 'https://platform.brexapis.com',
    };
    return new BrexIntegration('brex', authConfig, service, brexRateLimiter);
  },
  metadata: {
    website: 'https://www.brex.com',
    apiDocumentation: 'https://developer.brex.com/',
  },
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
  independentReserveConfig,
  btcMarketsConfig,
  bitfinexConfig,
  bitpandaConfig,
  bitflyerConfig,
  coincheckConfig,
  bitbankConfig,
  alpacaConfig,
  tinkoffConfig,
  tigerConfig,
  zerodhaConfig,
  mercuryConfig,
  brexConfig,
];
