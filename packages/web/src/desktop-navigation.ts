import type {
  GianDesktopNavigationApi,
  GianDesktopNavigationTarget,
} from './desktop-bridge.js';

/**
 * Join the cold-start ready handshake with live navigation pushes without
 * allowing an older ready result to overwrite a newer notification click.
 */
export function subscribeDesktopNavigation(
  navigation: GianDesktopNavigationApi,
  handle: (target: GianDesktopNavigationTarget) => void,
): () => void {
  let disposed = false;
  let liveRevision = 0;

  const consume = (target: GianDesktopNavigationTarget) => {
    if (disposed) return;
    handle(target);
    void navigation.acknowledge(target).catch(() => undefined);
  };

  const unsubscribe = navigation.onTarget(target => {
    liveRevision += 1;
    consume(target);
  });
  const readyRevision = liveRevision;
  void navigation.ready().then(target => {
    if (!target || disposed || liveRevision !== readyRevision) return;
    consume(target);
  }).catch(() => undefined);

  return () => {
    disposed = true;
    unsubscribe();
  };
}
