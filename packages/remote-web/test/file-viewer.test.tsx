import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import type { FileViewerState } from '../src/controller/types.js';

const HANDLE = { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' };

function withViewer(viewer: FileViewerState, viewport: 'wide' | 'mid' | 'narrow' = 'wide') {
  return renderApp({ scenario: { fileViewer: viewer }, viewport });
}

describe('read-only file viewer (B8)', () => {
  it('ready: renders content, read-only badge, download + close; no edit surface', () => {
    withViewer({ status: 'ready', handle: HANDLE, text: '#!/bin/sh\nset -e\n', sizeLabel: '12 B' });
    expect(screen.getByTestId('file-content').textContent).toContain('set -e');
    expect(screen.getByText('只读')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载' })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: /edit|编辑/i })).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('display label shows dir/name only — never an absolute Host path', () => {
    withViewer({ status: 'ready', handle: { id: 'f', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' }, text: 'x', sizeLabel: '1 B' });
    expect(document.body.textContent).not.toContain('/Users/');
    expect(document.body.textContent).not.toContain('/home/');
  });

  it('loading / binary / expired / too_large / error states', () => {
    const states: Array<[FileViewerState, RegExp]> = [
      [{ status: 'loading', handle: HANDLE }, /加载文件/],
      [{ status: 'binary', handle: HANDLE }, /二进制文件不支持预览/],
      [{ status: 'expired', handle: HANDLE }, /已过期/],
      [{ status: 'too_large', handle: HANDLE, limitLabel: '1 MB' }, /超过预览上限（1 MB）/],
      [{ status: 'error', handle: HANDLE, message: 'boom' }, /boom/],
    ];
    for (const [viewer, pattern] of states) {
      const { unmount } = withViewer(viewer);
      expect(screen.getByText(pattern)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders an E2EE image preview without navigating to a Host URL', () => {
    withViewer({
      status: 'image',
      handle: { ...HANDLE, label: 'screen.png' },
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mime: 'image/png',
    });
    expect(screen.getByRole('img', { name: 'screen.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('changed state warns and offers reload', async () => {
    const user = userEvent.setup();
    const { controller } = withViewer({ status: 'changed', handle: HANDLE, text: 'old' });
    expect(screen.getByText(/已在 Host 上变更/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(controller.state.fileViewer?.status).toBe('ready');
  });

  it('download progress and failure surfaces', async () => {
    const user = userEvent.setup();
    const { controller } = withViewer({ status: 'ready', handle: HANDLE, text: 'x', sizeLabel: '1 B' });
    await user.click(screen.getByRole('button', { name: '下载' }));
    controller.test.setDownload(45);
    expect(screen.getByText(/下载中…45%/)).toBeInTheDocument();
    controller.test.failDownload('network');
    expect(screen.getByText(/下载失败：network/)).toBeInTheDocument();
  });

  it('three layout tiers: wide=panel, mid=full main panel, narrow=full page with back', async () => {
    const user = userEvent.setup();
    const wide = withViewer({ status: 'ready', handle: HANDLE, text: 'x', sizeLabel: '1 B' }, 'wide');
    expect(document.querySelector('.sheet.rw-file-sheet')).not.toBeNull();
    wide.unmount();

    const mid = withViewer({ status: 'ready', handle: HANDLE, text: 'x', sizeLabel: '1 B' }, 'mid');
    expect(document.querySelector('.sheet.rw-file-sheet')).toBeNull();
    expect(screen.getByRole('button', { name: '返回 chat' })).toBeInTheDocument();
    mid.unmount();

    const narrow = renderApp({
      scenario: { fileViewer: { status: 'ready', handle: HANDLE, text: 'x', sizeLabel: '1 B' }, mobilePage: 'file' },
      viewport: 'narrow',
    });
    const back = screen.getByRole('button', { name: '返回' });
    await user.click(back);
    expect(narrow.controller.state.fileViewer).toBeNull();
    expect(narrow.controller.state.mobilePage).toBe('chat');
  });
});
