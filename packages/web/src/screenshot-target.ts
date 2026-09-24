import type { GianScreenshotStartResult, GianScreenshotTarget } from '@gian/shared';
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

/**
 * Ask the Desktop shell to start an interactive capture. `busy` means a
 * capture is already running; other failures are also broadcast through the
 * bridge's screenshot error event.
 */
export async function startScreenshotCapture(): Promise<GianScreenshotStartResult> {
  const api = desktopBridge()?.screenshot;
  if (!api) return { ok: false };
  return api.start();
}
