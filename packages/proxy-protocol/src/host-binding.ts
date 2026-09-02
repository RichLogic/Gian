import { createHmac, timingSafeEqual } from 'node:crypto';

export interface NativeSessionHostBinding {
  pluginId: string;
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
}

function bindingPayload(binding: NativeSessionHostBinding): string {
  return JSON.stringify([
    'gian.proxy/2.1/session.create/host-binding/v1',
    binding.pluginId,
    binding.sessionId,
    binding.nativeSessionId,
    binding.cwd,
  ]);
}

export function signNativeSessionHostBinding(
  key: string,
  binding: NativeSessionHostBinding,
): string {
  return createHmac('sha256', key).update(bindingPayload(binding)).digest('base64url');
}

export function verifyNativeSessionHostBinding(
  key: string,
  binding: NativeSessionHostBinding,
  proof: string,
): boolean {
  const expected = Buffer.from(signNativeSessionHostBinding(key, binding));
  const received = Buffer.from(proof);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
