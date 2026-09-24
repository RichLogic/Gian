/**
 * Browser panel — "attach page content as composer context".
 *
 * Three actions on the ⋯ menu drop content from the active Browser tab into
 * the published target Session's composer (never auto-sent):
 *
 *  - Attach screenshot: the main-owned bounded viewport capture (the same
 *    ≤1600px / ≤4MiB PNG the agent's browser.screenshot tool produces) is
 *    uploaded as a regular image attachment, reusing the proven
 *    upload → injectComposerAttachment path the OS-screenshot flow uses.
 *  - Attach page snapshot: the main-owned accessibility-tree text (the same
 *    sanitized artifact browser.snapshot returns — never raw HTML, keeping
 *    the ADR-0039 boundary) becomes one pastedText context chip.
 *  - Attach tab reference: a cheap pointer chip (title + url + tabId) that
 *    tells the model it can drive the tab with the browser tools.
 *
 * Shape decision: reuse pastedText rather than a new context-item variant
 * (same as the Changes inspector's attach-diff). The Host enforces
 * MAX_PASTED_TEXT_BYTES (64 KiB) on pastedText at the send boundary, so
 * oversized snapshots are cut at a line boundary and end with the same
 * [truncated] marker the Host's reference compile uses. The first line
 * carries an English, model-facing descriptor — it doubles as the chip label
 * (contextReferenceLabel takes the text's flattened head) and tells the
 * model what it is looking at, so it stays English regardless of UI locale.
 * The snapshot descriptor also carries the tabId and main-owned snapshotId,
 * which keeps the tree's `@eN` refs actionable for the browser tools until
 * the next snapshot on that tab.
 */
import {
  MAX_PASTED_TEXT_BYTES,
  type GianBrowserApi,
  type GianBrowserPageSnapshotCapture,
  type PastedTextContextItem,
} from '@gian/shared';
import { uploadAttachment, type UploadedAttachment } from '../api.js';
import {
  injectComposerAttachment,
  injectComposerContextItems,
} from '../components/Composer.js';

export const BROWSER_CONTEXT_TRUNCATED_MARKER = '[truncated]';

const encoder = new TextEncoder();
function byteSize(text: string): number {
  return encoder.encode(text).byteLength;
}

export interface BrowserTabDescriptor {
  tabId: string;
  title: string;
  url: string;
}

function descriptorTitle(tab: Pick<BrowserTabDescriptor, 'title' | 'url'>): string {
  return tab.title.trim() || tab.url;
}

/** Small pointer chip: the descriptor line doubles as the chip label, and the
 *  second line tells the model the tab is drivable through the browser tools. */
export function assembleBrowserTabReferenceText(tab: BrowserTabDescriptor): string {
  return `Browser tab · ${descriptorTitle(tab)} · ${tab.url} · tabId ${tab.tabId}\n`
    + `This tab is open in Gian Browser; use the browser tools with tab_id "${tab.tabId}" to inspect or interact with it.`;
}

/** Cut `body` at a line boundary so it fits `budgetBytes`; the cut can never
 *  split a multi-byte UTF-8 sequence. */
function truncateAtLineBoundary(body: string, budgetBytes: number): { text: string; truncated: boolean } {
  if (byteSize(body) <= budgetBytes) return { text: body, truncated: false };
  const lines: string[] = [];
  let used = 0;
  for (const line of body.split('\n')) {
    const cost = byteSize(line) + (lines.length > 0 ? 1 : 0);
    if (used + cost > budgetBytes) break;
    lines.push(line);
    used += cost;
  }
  return { text: lines.join('\n'), truncated: true };
}

/** Header + AX-tree text under the Host's pastedText byte budget. The marker
 *  is appended when the main-side capture was already truncated (its 128 KiB
 *  cap / node budget) or when the 64 KiB chip budget cut the tree. */
export function assembleBrowserPageSnapshotText(
  tabId: string,
  capture: GianBrowserPageSnapshotCapture,
): string {
  const header = `Page snapshot · ${descriptorTitle(capture)} · ${capture.url}`
    + ` · tabId ${tabId} · snapshotId ${capture.snapshotId}\n\n`;
  const budget = MAX_PASTED_TEXT_BYTES
    - byteSize(header)
    - BROWSER_CONTEXT_TRUNCATED_MARKER.length - 1;
  const body = truncateAtLineBoundary(capture.tree.replace(/\n+$/, ''), budget);
  let text = header + body.text;
  if (body.truncated || capture.truncated) text += `\n${BROWSER_CONTEXT_TRUNCATED_MARKER}`;
  return text;
}

export type BrowserContextAttachResult = 'attached' | 'full' | 'capture-failed';

function pastedTextItem(text: string): PastedTextContextItem {
  return {
    type: 'pastedText',
    id: crypto.randomUUID(),
    text,
    lineCount: text.split('\n').length,
    byteSize: byteSize(text),
  };
}

/** Cheap, capture-free chip pointing the model at an open Browser tab. */
export function attachBrowserTabReference(
  sessionId: string,
  tab: BrowserTabDescriptor,
): 'attached' | 'full' {
  return injectComposerContextItems(sessionId, [pastedTextItem(assembleBrowserTabReferenceText(tab))])
    ? 'attached'
    : 'full';
}

/** Capture the page's accessibility tree main-side and attach it as one
 *  pastedText chip. */
export async function attachBrowserPageSnapshot(
  browser: Pick<GianBrowserApi, 'capturePageSnapshot'>,
  tabId: string,
  sessionId: string,
): Promise<BrowserContextAttachResult> {
  const capture = await browser.capturePageSnapshot(tabId);
  if (!capture || !capture.tree.trim()) return 'capture-failed';
  const item = pastedTextItem(assembleBrowserPageSnapshotText(tabId, capture));
  return injectComposerContextItems(sessionId, [item]) ? 'attached' : 'full';
}

export type BrowserScreenshotAttachResult = 'attached' | 'capture-failed' | 'upload-failed';

export interface BrowserScreenshotAttachDeps {
  upload?: typeof uploadAttachment;
  inject?: (sessionId: string, attachment: UploadedAttachment) => void;
  now?: () => Date;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function browserScreenshotFilename(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `browser-screenshot-${stamp}.png`;
}

/** Capture the viewport main-side and attach the PNG as a regular image
 *  attachment in the target Session's draft. */
export async function attachBrowserPageScreenshot(
  browser: Pick<GianBrowserApi, 'capturePageScreenshot'>,
  tabId: string,
  sessionId: string,
  deps: BrowserScreenshotAttachDeps = {},
): Promise<BrowserScreenshotAttachResult> {
  const capture = await browser.capturePageScreenshot(tabId);
  if (!capture) return 'capture-failed';
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(capture.base64);
  } catch {
    return 'capture-failed';
  }
  const filename = browserScreenshotFilename((deps.now ?? (() => new Date()))());
  let uploaded: UploadedAttachment;
  try {
    uploaded = await (deps.upload ?? uploadAttachment)(
      sessionId,
      new Blob([bytes.slice().buffer], { type: capture.mimeType }),
      filename,
    );
  } catch {
    return 'upload-failed';
  }
  (deps.inject ?? injectComposerAttachment)(sessionId, uploaded);
  return 'attached';
}
