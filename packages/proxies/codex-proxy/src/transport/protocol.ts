export function writeJsonLine(stream: NodeJS.WritableStream, payload: unknown) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function protocolError(error: unknown, fallbackCode = 'INTERNAL_ERROR') {
  const code = typeof error === 'object' && error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

export function createProtocolWriter(outputStream: NodeJS.WritableStream) {
  return {
    result(id: number | string | undefined, result: unknown) {
      writeJsonLine(outputStream, { id, result });
    },
    error(id: number | string | undefined, error: unknown) {
      writeJsonLine(outputStream, { id, error: protocolError(error) });
    },
    notification(method: string, params: unknown = {}) {
      writeJsonLine(outputStream, { method, params });
    },
  };
}
