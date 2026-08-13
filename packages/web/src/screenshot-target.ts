import type { GianScreenshotTarget } from '@gian/shared';
import { desktopBridge } from './desktop-bridge.js';

let currentOwner: symbol | null = null;

/**
 * Publish the composer that should receive a capture. The Desktop process
 * snapshots this target when capture starts, so later navigation cannot move
 * the finished image to a different conversation.
 */
export function publishScreenshotTarget(target: GianScreenshotTarget): () => void {
  const owner = Symbol('screenshot-target');
  currentOwner = owner;
  void desktopBridge()?.screenshot?.setTarget(target);
  return () => {
    if (currentOwner !== owner) return;
    currentOwner = null;
    void desktopBridge()?.screenshot?.setTarget(null);
  };
}

export async function startScreenshotCapture(): Promise<boolean> {
  const api = desktopBridge()?.screenshot;
  if (!api) return false;
  const result = await api.start();
  return result.ok;
}
