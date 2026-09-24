import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_CONTEXT_ITEMS, MAX_PASTED_TEXT_BYTES } from '@gian/shared';
import type { GianBrowserPageSnapshotCapture, PastedTextContextItem } from '@gian/shared';
import {
  assembleBrowserPageSnapshotText,
  assembleBrowserTabReferenceText,
  attachBrowserPageScreenshot,
  attachBrowserPageSnapshot,
  attachBrowserTabReference,
  BROWSER_CONTEXT_TRUNCATED_MARKER,
} from '../src/controllers/browser-panel-context.js';

const SESSION_ID = 'session-browser-attach';
const TAB_ID = 'tab-attach-test';
const DRAFT_KEY = `gian.composer.draft.v4.${SESSION_ID}`;

function readDraft(): {
  contextItems: PastedTextContextItem[];
  attachments: Array<{ path: string; name: string; mime: string }>;
} {
  return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
}

function snapshotCapture(overrides: Partial<GianBrowserPageSnapshotCapture> = {}): GianBrowserPageSnapshotCapture {
  return {
    url: 'https://example.com/docs',
    title: 'Example Docs',
    tree: '- RootWebArea "Example Docs"\n  - heading "Welcome"\n  - link "More" [ref=@e1]',
    truncated: false,
    snapshotId: 'browser-snapshot-123',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('assembleBrowserTabReferenceText', () => {
  it('leads with an English descriptor carrying title, url and tabId, and points the model at the browser tools', () => {
    const text = assembleBrowserTabReferenceText({
      tabId: TAB_ID,
      title: 'Example',
      url: 'https://example.com/',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(`Browser tab · Example · https://example.com/ · tabId ${TAB_ID}`);
    expect(lines[1]).toContain(`tab_id "${TAB_ID}"`);
    expect(lines[1]).toContain('browser tools');
  });

  it('falls back to the url when the page has no title', () => {
    const text = assembleBrowserTabReferenceText({ tabId: TAB_ID, title: '  ', url: 'https://example.com/' });
    expect(text.split('\n')[0]).toBe(`Browser tab · https://example.com/ · https://example.com/ · tabId ${TAB_ID}`);
  });
});

describe('assembleBrowserPageSnapshotText', () => {
  it('leads with a descriptor carrying title, url, tabId and snapshotId, then the tree', () => {
    const text = assembleBrowserPageSnapshotText(TAB_ID, snapshotCapture());
    const [header, blank, ...tree] = text.split('\n');
    expect(header).toBe(
      `Page snapshot · Example Docs · https://example.com/docs · tabId ${TAB_ID} · snapshotId browser-snapshot-123`,
    );
    expect(blank).toBe('');
    expect(tree.join('\n')).toBe(snapshotCapture().tree);
    expect(text).not.toContain(BROWSER_CONTEXT_TRUNCATED_MARKER);
  });

  it('keeps the main-side truncation marker even when the tree fits the chip budget', () => {
    const text = assembleBrowserPageSnapshotText(TAB_ID, snapshotCapture({ truncated: true }));
    expect(text.endsWith(`\n${BROWSER_CONTEXT_TRUNCATED_MARKER}`)).toBe(true);
  });

  it('truncates oversized trees at a line boundary under the Host pastedText cap', () => {
    // Multi-byte content must never be split mid-sequence: each line holds
    // CJK characters (3 bytes each in UTF-8).
    const line = `- 文本 "汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字"`;
    const tree = Array.from({ length: 4_000 }, () => line).join('\n');
    const text = assembleBrowserPageSnapshotText(TAB_ID, snapshotCapture({ tree }));
    const byteSize = new TextEncoder().encode(text).byteLength;
    expect(byteSize).toBeLessThanOrEqual(MAX_PASTED_TEXT_BYTES);
    expect(text.endsWith(`\n${BROWSER_CONTEXT_TRUNCATED_MARKER}`)).toBe(true);
    // Every kept body line is whole — the cut never splits a line (or a
    // multi-byte character).
    const body = text.split('\n\n')[1]!;
    const keptLines = body.replace(`\n${BROWSER_CONTEXT_TRUNCATED_MARKER}`, '').split('\n');
    for (const kept of keptLines) expect(kept).toBe(line);
  });
});

describe('attachBrowserTabReference', () => {
  it('injects a pastedText chip into the target Session draft', () => {
    const result = attachBrowserTabReference(SESSION_ID, {
      tabId: TAB_ID,
      title: 'Example',
      url: 'https://example.com/',
    });
    expect(result).toBe('attached');
    const draft = readDraft();
    expect(draft.contextItems).toHaveLength(1);
    expect(draft.contextItems[0]).toEqual(expect.objectContaining({
      type: 'pastedText',
      lineCount: 2,
    }));
    expect(draft.contextItems[0]!.text).toContain(`tabId ${TAB_ID}`);
  });

  it('reports full when the draft already holds the context-item limit', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      text: '',
      document: { version: 1, segments: [] },
      attachments: [],
      contextItems: Array.from({ length: MAX_MESSAGE_CONTEXT_ITEMS }, (_, index) => ({
        type: 'pastedText',
        id: `existing-${index}`,
        text: `note ${index}`,
        lineCount: 1,
        byteSize: 8,
      })),
    }));
    expect(attachBrowserTabReference(SESSION_ID, {
      tabId: TAB_ID,
      title: 'Example',
      url: 'https://example.com/',
    })).toBe('full');
    expect(readDraft().contextItems).toHaveLength(MAX_MESSAGE_CONTEXT_ITEMS);
  });
});

describe('attachBrowserPageSnapshot', () => {
  it('attaches the captured AX tree as a pastedText chip', async () => {
    const capturePageSnapshot = vi.fn().mockResolvedValue(snapshotCapture());
    const result = await attachBrowserPageSnapshot({ capturePageSnapshot }, TAB_ID, SESSION_ID);
    expect(result).toBe('attached');
    expect(capturePageSnapshot).toHaveBeenCalledWith(TAB_ID);
    const draft = readDraft();
    expect(draft.contextItems).toHaveLength(1);
    expect(draft.contextItems[0]!.text).toContain('Page snapshot · Example Docs');
    expect(draft.contextItems[0]!.text).toContain('- link "More" [ref=@e1]');
  });

  it('fails closed when the main-side capture is unavailable or empty', async () => {
    const unavailable = vi.fn().mockResolvedValue(null);
    await expect(attachBrowserPageSnapshot({ capturePageSnapshot: unavailable }, TAB_ID, SESSION_ID))
      .resolves.toBe('capture-failed');
    const empty = vi.fn().mockResolvedValue(snapshotCapture({ tree: '  \n ' }));
    await expect(attachBrowserPageSnapshot({ capturePageSnapshot: empty }, TAB_ID, SESSION_ID))
      .resolves.toBe('capture-failed');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe('attachBrowserPageScreenshot', () => {
  const pngBase64 = btoa('png-bytes');
  const capture = { mimeType: 'image/png' as const, base64: pngBase64, width: 1_280, height: 800 };

  it('uploads the decoded PNG and injects the attachment into the target draft', async () => {
    const capturePageScreenshot = vi.fn().mockResolvedValue(capture);
    const upload = vi.fn().mockResolvedValue({
      path: '/uploads/abc.png',
      name: 'browser-screenshot-20260921T120000Z.png',
      mime: 'image/png',
      size: 9,
    });
    const inject = vi.fn();
    const now = () => new Date('2026-09-21T12:00:00.000Z');
    const result = await attachBrowserPageScreenshot(
      { capturePageScreenshot },
      TAB_ID,
      SESSION_ID,
      { upload, inject, now },
    );
    expect(result).toBe('attached');
    expect(capturePageScreenshot).toHaveBeenCalledWith(TAB_ID);
    expect(upload).toHaveBeenCalledTimes(1);
    const [sessionId, blob, filename] = upload.mock.calls[0]!;
    expect(sessionId).toBe(SESSION_ID);
    expect(filename).toBe('browser-screenshot-20260921T120000Z.png');
    expect((blob as Blob).type).toBe('image/png');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob as Blob);
    });
    expect(text).toBe('png-bytes');
    expect(inject).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ path: '/uploads/abc.png' }));
  });

  it('fails closed when the main-side capture is unavailable', async () => {
    const capturePageScreenshot = vi.fn().mockResolvedValue(null);
    const upload = vi.fn();
    await expect(attachBrowserPageScreenshot(
      { capturePageScreenshot },
      TAB_ID,
      SESSION_ID,
      { upload, inject: vi.fn() },
    )).resolves.toBe('capture-failed');
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports upload-failed without injecting when the upload rejects', async () => {
    const capturePageScreenshot = vi.fn().mockResolvedValue(capture);
    const upload = vi.fn().mockRejectedValue(new Error('413'));
    const inject = vi.fn();
    await expect(attachBrowserPageScreenshot(
      { capturePageScreenshot },
      TAB_ID,
      SESSION_ID,
      { upload, inject },
    )).resolves.toBe('upload-failed');
    expect(inject).not.toHaveBeenCalled();
  });
});
