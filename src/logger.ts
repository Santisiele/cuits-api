import pino from "pino"

/**
 * Shared logger instance for the entire application.
 * Uses pino-pretty for human-readable output in development.
 */
export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
})