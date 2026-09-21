/**
 * Routes an arbitrary http(s) URL into the desktop shell's in-app Browser,
 * mirroring `openBrowserPreview`'s blank-tab reuse: a Browser tab already
 * showing the URL (or still navigating to it) is only revealed, a
 * never-navigated blank tab is reused in place, and a fresh tab is minted
 * only when every existing Browser tab shows other content.
 *
 * React-free so the workbench can wire its state in per render. Returns
 * false when no desktop Browser bridge exists (plain browser-hosted web) so
 * the caller falls back to a `_blank` window.
 */

import type { GianBrowserApi } from '@gian/shared';
import { desktopBridge } from '../desktop-bridge.js';
import { findBlankBrowserTab, type BrowserTabLike } from '../presentation/browser-tabs.js';

export function createBrowserUrlOpener(deps: {
  tabs: ReadonlyArray<BrowserTabLike>;
  urls: ReadonlyMap<string, string>;
  /** Synchronously records the URL a tab is about to load, so a second open
   *  of the same URL before the native navigation event lands only reveals
   *  the tab instead of navigating or minting again. */
  claimTab: (tabId: string, url: string) => void;
  /** Surfaces the Browser rail (un-collapsing it) and, when tabId is given,
   *  selects that tab. */
  revealBrowserTab: (tabId: string | null) => void;
  createBrowserTab: (onCreated: (browser: GianBrowserApi, tabId: string) => void) => void;
}): (url: string) => boolean {
  return (url) => {
    const browser = desktopBridge()?.browser;
    if (!browser) return false;
    for (const tab of deps.tabs) {
      if (tab.kind !== 'browser') continue;
      if (deps.urls.get(tab.id) === url) {
        deps.revealBrowserTab(tab.id);
        return true;
      }
    }
    const blankId = findBlankBrowserTab(deps.tabs, deps.urls);
    if (blankId) {
      deps.claimTab(blankId, url);
      deps.revealBrowserTab(blankId);
      void browser.navigate(blankId, url);
      return true;
    }
    deps.revealBrowserTab(null);
    deps.createBrowserTab((createdBrowser, tabId) => {
      deps.claimTab(tabId, url);
      void createdBrowser.navigate(tabId, url);
    });
    return true;
  };
}
