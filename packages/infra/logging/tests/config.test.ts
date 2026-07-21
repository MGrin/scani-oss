import { afterEach, describe, expect, test } from 'bun:test';
import { loadLoggingConfig, resetLoggingConfig } from '../src/config';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  resetLoggingConfig();
});

describe('loadLoggingConfig defaults (non-production)', () => {
  test('falls back to documented defaults when nothing is set', () => {
    resetLoggingConfig();
    const config = loadLoggingConfig({});
    expect(config.level).toBe('info');
    expect(config.pretty).toBe(false);
    expect(config.timestamp).toBe(true);
    expect(config.colorize).toBe(false);
    expect(config.logSqlQueries).toBe(false);
    expect(config.logRequestBodies).toBe(false);
    expect(config.logResponseBodies).toBe(false);
    expect(config.logWebSocketMessages).toBe(true);
    expect(config.serviceName).toBe('scani');
    expect(config.serviceVersion).toBe('unknown');
    expect(config.hostname).toBe('localhost');
    expect(config.logIdPepper).toBeUndefined();
  });

  test('reads explicit values and lowercases the level', () => {
    resetLoggingConfig();
    const config = loadLoggingConfig({
      LOG_LEVEL: 'WARN',
      LOG_TIMESTAMP: 'false',
      LOG_SQL_QUERIES: 'true',
      LOG_WEBSOCKET_MESSAGES: 'false',
      SERVICE_NAME: 'worker',
      SERVICE_VERSION: 'abc123',
      HOSTNAME: 'pod-7',
    });
    expect(config.level).toBe('warn');
    expect(config.timestamp).toBe(false);
    expect(config.logSqlQueries).toBe(true);
    expect(config.logWebSocketMessages).toBe(false);
    expect(config.serviceName).toBe('worker');
    expect(config.serviceVersion).toBe('abc123');
    expect(config.hostname).toBe('pod-7');
  });

  test('body-logging flags are honoured outside production', () => {
    resetLoggingConfig();
    const config = loadLoggingConfig({
      LOG_REQUEST_BODIES: 'true',
      LOG_RESPONSE_BODIES: 'true',
    });
    expect(config.logRequestBodies).toBe(true);
    expect(config.logResponseBodies).toBe(true);
  });

  test('caches the first parse until reset', () => {
    resetLoggingConfig();
    const first = loadLoggingConfig({ LOG_LEVEL: 'error' });
    const second = loadLoggingConfig({ LOG_LEVEL: 'trace' });
    expect(second).toBe(first);
    expect(second.level).toBe('error');

    resetLoggingConfig();
    const third = loadLoggingConfig({ LOG_LEVEL: 'trace' });
    expect(third.level).toBe('trace');
  });
});

describe('loadLoggingConfig production guards', () => {
  const prodEnv = { LOG_ID_PEPPER: 'a'.repeat(32) };

  test('refuses body logging in production', () => {
    process.env.NODE_ENV = 'production';
    resetLoggingConfig();
    expect(() => loadLoggingConfig({ ...prodEnv, LOG_REQUEST_BODIES: 'true' })).toThrow(
      /LOG_REQUEST_BODIES/
    );
    resetLoggingConfig();
    expect(() => loadLoggingConfig({ ...prodEnv, LOG_RESPONSE_BODIES: 'true' })).toThrow(
      /must not be enabled in production/
    );
  });

  test('requires a 16+ char LOG_ID_PEPPER in production', () => {
    process.env.NODE_ENV = 'production';
    resetLoggingConfig();
    expect(() => loadLoggingConfig({})).toThrow(/LOG_ID_PEPPER/);
    resetLoggingConfig();
    expect(() => loadLoggingConfig({ LOG_ID_PEPPER: 'short' })).toThrow(/16/);
    resetLoggingConfig();
    expect(loadLoggingConfig(prodEnv).logIdPepper).toBe(prodEnv.LOG_ID_PEPPER);
  });

  test('forces pretty and colorize off in production', () => {
    process.env.NODE_ENV = 'production';
    resetLoggingConfig();
    const config = loadLoggingConfig({ ...prodEnv, LOG_PRETTY: 'true', LOG_COLORIZE: 'true' });
    expect(config.pretty).toBe(false);
    expect(config.colorize).toBe(false);
    expect(config.level).toBe('info');
  });
});
