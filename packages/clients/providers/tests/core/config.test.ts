import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadProvidersConfig, resetProvidersConfig } from '../../src/core/config';

describe('loadProvidersConfig', () => {
  beforeEach(() => {
    resetProvidersConfig();
  });
  afterEach(() => {
    resetProvidersConfig();
  });

  test('accepts an empty env (every field optional)', () => {
    const cfg = loadProvidersConfig({} as NodeJS.ProcessEnv);
    expect(cfg.COINGECKO_API_KEY).toBeUndefined();
    expect(cfg.FINNHUB_API_KEY).toBeUndefined();
  });

  test('parses populated keys verbatim', () => {
    const cfg = loadProvidersConfig({
      COINGECKO_API_KEY: 'cg-x',
      FINNHUB_API_KEY: 'fh-y',
      OPENAI_API_KEY: 'sk-z',
      OPENAI_VISION_MODEL: 'gpt-4o',
      ETHERSCAN_API_KEY: 'es-w',
      HELIUS_API_KEY: 'he-v',
      GOOGLE_SHEETS_ID: 'sheet-id',
      GOOGLE_SERVICE_ACCOUNT_KEY: 'base64-key',
    } as NodeJS.ProcessEnv);
    expect(cfg.COINGECKO_API_KEY).toBe('cg-x');
    expect(cfg.FINNHUB_API_KEY).toBe('fh-y');
    expect(cfg.OPENAI_API_KEY).toBe('sk-z');
    expect(cfg.OPENAI_VISION_MODEL).toBe('gpt-4o');
    expect(cfg.GOOGLE_SHEETS_ID).toBe('sheet-id');
  });

  test('caches across calls', () => {
    const a = loadProvidersConfig({ COINGECKO_API_KEY: 'first' } as NodeJS.ProcessEnv);
    const b = loadProvidersConfig({ COINGECKO_API_KEY: 'second' } as NodeJS.ProcessEnv);
    expect(a).toBe(b);
    expect(b.COINGECKO_API_KEY).toBe('first');
  });

  test('resetProvidersConfig clears the cache', () => {
    loadProvidersConfig({ COINGECKO_API_KEY: 'first' } as NodeJS.ProcessEnv);
    resetProvidersConfig();
    const cfg = loadProvidersConfig({ COINGECKO_API_KEY: 'second' } as NodeJS.ProcessEnv);
    expect(cfg.COINGECKO_API_KEY).toBe('second');
  });
});
