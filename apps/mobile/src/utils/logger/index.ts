import * as Sentry from "@sentry/react-native"

import type { ILogger, LogContext } from "./types"

type LogLevel = "debug" | "info" | "warn" | "error"

class Logger implements ILogger {
  private isDev = __DEV__

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error) {
    const timestamp = new Date().toISOString()
    const logData = {
      timestamp,
      level,
      message,
      ...context,
    }

    if (this.isDev) {
      // this.logToConsole(level, message, logData, error)
      this.logToReactotron(level, message, context, error)
    } else {
      // this.logToConsole(level, message, logData, error)
      this.logToSentry(level, message, logData, error)
    }
  }

  private logToConsole(level: LogLevel, message: string, data: unknown, error?: Error) {
    const prefix = `[${level.toUpperCase()}]`

    switch (level) {
      case "debug":
        console.debug(prefix, message, data)
        break
      case "info":
        console.info(prefix, message, data)
        break
      case "warn":
        console.warn(prefix, message, data)
        if (error) console.warn(error)
        break
      case "error":
        console.error(prefix, message, data)
        if (error) console.error(error)
        break
    }
  }

  private logToReactotron(level: LogLevel, message: string, context?: LogContext, error?: Error) {
    if (!__DEV__ || typeof console.tron === "undefined") return

    try {
      if (level === "error") {
        console.tron.error(error || new Error(message), message)
        if (context && Object.keys(context).length > 0) {
          console.tron.display({
            name: `Error Context [${level.toUpperCase()}]`,
            preview: message,
            value: context,
            important: true,
          })
        }
      } else if (context && Object.keys(context).length > 0) {
        console.tron.display({
          name: `Log [${level.toUpperCase()}]`,
          preview: message,
          value: context,
          important: level === "warn",
        })
      } else {
        console.tron.log(message)
      }
    } catch (e) {
      console.warn("Failed to log to Reactotron", e)
    }
  }

  private logToSentry(level: LogLevel, message: string, data: unknown, error?: Error) {
    try {
      Sentry.addBreadcrumb({
        message,
        level: level as Sentry.SeverityLevel,
        data: data as Record<string, unknown>,
      })

      if (level === "error" && error) {
        Sentry.captureException(error, {
          contexts: {
            data: data as Record<string, unknown>,
          },
        })
      } else if (level === "error") {
        Sentry.captureMessage(message, {
          level: "error",
          contexts: {
            data: data as Record<string, unknown>,
          },
        })
      }
    } catch (e) {
      console.warn("Failed to log to Sentry", e)
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log("debug", message, context)
  }

  info(message: string, context?: LogContext): void {
    this.log("info", message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.log("warn", message, context)
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log("error", message, context, error)
  }

  console(value: unknown, label?: string): void {
    const timestamp = new Date().toISOString()
    const prefix = label ? `[CONSOLE] ${label}:` : "[CONSOLE]"

    console.log("\n" + "=".repeat(80))
    console.log(`${prefix} ${timestamp}`)
    console.log("=".repeat(80))

    if (value === null) {
      console.log("null")
    } else if (value === undefined) {
      console.log("undefined")
    } else if (value instanceof Error) {
      console.log("Error:", value.message)
      console.log("Stack:", value.stack)
    } else if (typeof value === "object") {
      try {
        console.log(JSON.stringify(value, null, 2))
      } catch {
        console.log("[Circular or non-serializable object]")
        console.dir(value)
      }
    } else {
      console.log(value)
    }

    console.log("=".repeat(80) + "\n")
  }

  setUser(userId: string, email?: string): void {
    if (!this.isDev) {
      Sentry.setUser({
        id: userId,
        email,
      })
    }

    this.info("User context set", { userId, email })
  }

  clearUser(): void {
    if (!this.isDev) {
      Sentry.setUser(null)
    }

    this.info("User context cleared")
  }
}

export const logger = new Logger()
