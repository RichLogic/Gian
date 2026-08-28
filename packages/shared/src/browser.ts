import type { GianBrowserElementCapture } from './browser-context.js';

export interface GianBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GianBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canOpenExternal: boolean;
  inspecting: boolean;
  error?: string;
}

export interface GianBrowserProjectTarget {
  workingTreeId: string;
  path: string;
}

/** Node-free API exposed only to Gian's trusted renderer. Previewed pages use
 * a separate WebContentsView with no preload, so they can never call this. */
export interface GianBrowserApi {
  getState(tabId: string): Promise<GianBrowserState>;
  navigate(tabId: string, url: string): Promise<GianBrowserState>;
  openProject(tabId: string, target: GianBrowserProjectTarget): Promise<GianBrowserState>;
  goBack(tabId: string): Promise<GianBrowserState>;
  goForward(tabId: string): Promise<GianBrowserState>;
  reload(tabId: string): Promise<GianBrowserState>;
  stop(tabId: string): Promise<GianBrowserState>;
  setLayout(tabId: string, bounds: GianBrowserBounds, visible: boolean): Promise<boolean>;
  openExternal(tabId: string): Promise<boolean>;
  closeTab(tabId: string): Promise<boolean>;
  clearData(): Promise<boolean>;
  setInspectMode(tabId: string, enabled: boolean): Promise<GianBrowserState>;
  subscribe(listener: (tabId: string, state: GianBrowserState) => void): () => void;
  subscribeElement(listener: (tabId: string, capture: GianBrowserElementCapture) => void): () => void;
}
