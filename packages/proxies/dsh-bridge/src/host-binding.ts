import { createHmac, timingSafeEqual } from 'node:crypto';

interface NativeSessionHostBinding {
  pluginId: string;
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
}

function payload(binding: NativeSessionHostBinding): string {
  return JSON.stringify([
    'gian.proxy/2.1/session.create/host-binding/v1',
    binding.pluginId,
    binding.sessionId,
    binding.nativeSessionId,
    binding.cwd,
  ]);
}

export function signHostBinding(key: string, binding: NativeSessionHostBinding): string {
  return createHmac('sha256', key).update(payload(binding)).digest('base64url');
}

export function verifyHostBinding(
  key: string,
  binding: NativeSessionHostBinding,
  proof: string,
): boolean {
  const expected = Buffer.from(signHostBinding(key, binding));
  const received = Buffer.from(proof);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
