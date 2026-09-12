/** Shared Browser-tab helpers: the default Sheet tab name plus the blank-tab
 *  lookup that lets "Open in Browser" reuse a never-navigated tab instead of
 *  stacking a new one next to it. */

export const DEFAULT_BROWSER_TAB_NAME = 'Browser';

/** Synchronous claim marker recorded while `browser.openProject` is in flight,
 *  so a second open in the same tick cannot reuse the same tab again. */
export const PENDING_BROWSER_TAB_URL = 'gian-browser:pending-navigation';

export interface BrowserTabLike {
  id: string;
  kind: string;
}

/** First Browser tab that has never loaded a page (no recorded URL, or the
 *  native side reports an empty/about:blank URL). */
export function findBlankBrowserTab(
  tabs: ReadonlyArray<BrowserTabLike>,
  urls: ReadonlyMap<string, string>,
): string | null {
  for (const tab of tabs) {
    if (tab.kind !== 'browser') continue;
    if (!urls.get(tab.id)) return tab.id;
  }
  return null;
}
