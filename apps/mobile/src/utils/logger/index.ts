import type { ILogger, LogContext } from './types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger implements ILogger {
  private isDev = __DEV__;

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error) {
    if (this.isDev) {
      this.logToReactotron(level, message, context, error);
    }
  }

  private logToReactotron(level: LogLevel, message: string, context?: LogContext, error?: Error) {
    if (!__DEV__ || typeof console.tron === 'undefined') return;

    try {
      if (level === 'error') {
        console.tron.error(error || new Error(message), message);
        if (context && Object.keys(context).length > 0) {
          console.tron.display({
            name: `Error Context [${level.toUpperCase()}]`,
            preview: message,
            value: context,
            important: true,
          });
        }
      } else if (context && Object.keys(context).length > 0) {
        console.tron.display({
          name: `Log [${level.toUpperCase()}]`,
          preview: message,
          value: context,
          important: level === 'warn',
        });
      } else {
        console.tron.log(message);
      }
    } catch (e) {
      console.warn('Failed to log to Reactotron', e);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log('error', message, context, error);
  }

  console(value: unknown, label?: string): void {
    const timestamp = new Date().toISOString();
    const prefix = label ? `[CONSOLE] ${label}:` : '[CONSOLE]';

    console.log(`\n${'='.repeat(80)}`);
    console.log(`${prefix} ${timestamp}`);
    console.log('='.repeat(80));

    if (value === null) {
      console.log('null');
    } else if (value === undefined) {
      console.log('undefined');
    } else if (value instanceof Error) {
      console.log('Error:', value.message);
      console.log('Stack:', value.stack);
    } else if (typeof value === 'object') {
      try {
        console.log(JSON.stringify(value, null, 2));
      } catch {
        console.log('[Circular or non-serializable object]');
        console.dir(value);
      }
    } else {
      console.log(value);
    }

    console.log(`${'='.repeat(80)}\n`);
  }

  setUser(userId: string, email?: string): void {
    this.info('User context set', { userId, email });
  }

  clearUser(): void {
    this.info('User context cleared');
  }
}

export const logger = new Logger();
