export const MAX_ANONYMOUS_METADATA_BYTES = 512 * 1024;
export const MAX_ANONYMOUS_ETAG_CHARS = 256;
export const MAX_ANONYMOUS_RELEASES = 100;

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  let declared: number | null;
  try {
    declared = parseContentLength(response.headers.get('content-length'));
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
  if (declared !== null && declared > maxBytes) {
    await cancelBody(response);
    throw new Error('Catalog response is too large.');
  }
  if (!response.body) throw new Error('Catalog response is empty.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel('Catalog response is too large.');
        await cancelBody(response);
        throw new Error('Catalog response is too large.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* already cancelled */ }
    throw error;
  }
  if (size === 0) throw new Error('Catalog response is empty.');
  return Buffer.concat(chunks, size);
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('Catalog response Content-Length is invalid.');
  }
  const declared = Number(value);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new Error('Catalog response Content-Length is invalid.');
  }
  return declared;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already cancelled */
  }
}
