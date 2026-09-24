type LogLevel = "info" | "warn" | "error";

/**
 * Emits one structured JSON line to stdout. Shared by requestLogger,
 * errorHandler, and the email delivery logging so every log line in the
 * service has the same shape (timestamp, level, message, plus context) and
 * can be parsed the same way downstream, instead of each caller hand-rolling
 * its own JSON.stringify.
 */
export function log(level: LogLevel, message: string, context: Record<string, unknown> = {}) {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    }) + "\n"
  );
}
