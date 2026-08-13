import { describe, expect, it, vi } from 'vitest';
import type {
  GianDesktopNavigationApi,
  GianDesktopNavigationTarget,
} from '../src/desktop-bridge.js';
import { subscribeDesktopNavigation } from '../src/desktop-navigation.js';

const targetA: GianDesktopNavigationTarget = {
  type: 'session',
  sessionId: 'session-a',
  turn: 1,
  kind: 'turn-completed',
};
const targetB: GianDesktopNavigationTarget = {
  type: 'session',
  sessionId: 'session-b',
  turn: 2,
  kind: 'approval',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('desktop navigation handshake', () => {
  it('drops a stale ready target after a newer live click arrives', async () => {
    const ready = deferred<GianDesktopNavigationTarget | null>();
    let live: ((target: GianDesktopNavigationTarget) => void) | null = null;
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => ready.promise,
      acknowledge,
      onTarget: listener => {
        live = listener;
        return () => { live = null; };
      },
    };
    const handled: GianDesktopNavigationTarget[] = [];
    const unsubscribe = subscribeDesktopNavigation(navigation, target => handled.push(target));

    (live as (target: GianDesktopNavigationTarget) => void)(targetB);
    ready.resolve(targetA);
    await ready.promise;
    await Promise.resolve();

    expect(handled).toEqual([targetB]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(targetB);
    unsubscribe();
  });

  it('consumes a cold-start target once and ignores it after disposal', async () => {
    const firstReady = deferred<GianDesktopNavigationTarget | null>();
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => firstReady.promise,
      acknowledge,
      onTarget: () => () => undefined,
    };
    const handled: GianDesktopNavigationTarget[] = [];
    subscribeDesktopNavigation(navigation, target => handled.push(target));
    firstReady.resolve(targetA);
    await firstReady.promise;
    await Promise.resolve();
    expect(handled).toEqual([targetA]);

    const lateReady = deferred<GianDesktopNavigationTarget | null>();
    const lateNavigation = { ...navigation, ready: () => lateReady.promise };
    const unsubscribe = subscribeDesktopNavigation(lateNavigation, target => handled.push(target));
    unsubscribe();
    lateReady.resolve(targetB);
    await lateReady.promise;
    await Promise.resolve();
    expect(handled).toEqual([targetA]);
  });
});
