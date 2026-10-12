import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { getTraceId } from './trace-context';

/** Nest console logger that tags every line emitted inside a request with its trace id. */
export class TraceLogger extends ConsoleLogger {
  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const traceId = getTraceId();
    const tagged = traceId ? `${contextMessage}[trace=${traceId}] ` : contextMessage;
    return super.formatMessage(logLevel, message, pidMessage, formattedLogLevel, tagged, timestampDiff);
  }
}
