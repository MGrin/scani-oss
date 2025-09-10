import { describe, expect, it } from 'bun:test';
import {
  createComponentLogger,
  createTimer,
  dbLogger,
  generateRequestId,
  logger,
  trpcLogger,
  wsLogger,
} from '../utils/logger';

describe('Logger', () => {
  it('should create component loggers', () => {
    const testLogger = createComponentLogger('test');
    expect(testLogger).toBeDefined();
  });

  it('should generate unique request IDs', () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThan(10);
  });

  it('should create and use timers', () => {
    const timer = createTimer();

    // Wait a small amount
    const start = Date.now();
    while (Date.now() - start < 10) {
      // Small delay
    }

    const duration = timer.end();
    expect(duration).toBeGreaterThan(0);
    expect(typeof duration).toBe('number');
  });

  it('should have all expected loggers', () => {
    expect(logger).toBeDefined();
    expect(trpcLogger).toBeDefined();
    expect(dbLogger).toBeDefined();
    expect(wsLogger).toBeDefined();
  });

  it('should log messages without throwing', () => {
    expect(() => {
      logger.info('Test info message');
      logger.debug('Test debug message');
      logger.warn('Test warning message');
    }).not.toThrow();
  });

  it('should handle child loggers', () => {
    const childLogger = logger.child({ requestId: 'test-123' });
    expect(() => {
      childLogger.info('Test child logger message');
    }).not.toThrow();
  });
});
