import { redactRemoteError, redactRemoteText } from '@gian/remote-protocol';

export interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(sink: LogSink = console): LogSink {
  return {
    info(message) {
      sink.info(redactRemoteText(message));
    },
    warn(message) {
      sink.warn(redactRemoteText(message));
    },
    error(message) {
      sink.error(redactRemoteText(message));
    },
  };
}

export function logError(sink: LogSink, error: unknown): void {
  sink.error(redactRemoteError(error));
}
