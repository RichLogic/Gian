import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab, SheetOpenWith } from '../src/components/Sheet.js';

const fileTab: SheetTab = {
  id: 't1', pane: 0, name: 'foo.ts', kind: 'file', icoKind: 'ts', ico: 'TS',
  lines: [['1', 'const a = 1'], ['2', 'const b = 2']],
  fullPath: '/tmp/demo/src/foo.ts', viewMode: 'source',
};

const actions = {
  activateTab: vi.fn(), closeTab: vi.fn(), pinTab: vi.fn(), setTabViewMode: vi.fn(),
};

function renderSheet(props: Partial<React.ComponentProps<typeof Sheet>> = {}) {
  return render(
    <Sheet tabs={[fileTab]} active={{ 0: 't1', 1: null }} actions={actions} {...props} />,
  );
}

describe('Sheet file actions', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.clear(); } catch { /* ignore */ }
    writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('"More actions" menu offers copy path, copy contents and word-wrap toggle', () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByText('Copy path')).toBeTruthy();
    expect(screen.getByText('Copy file contents')).toBeTruthy();
    // Wrap is the default, so the toggle offers to disable it.
    expect(screen.getByText('Disable word wrap')).toBeTruthy();
  });

  it('Copy path writes the absolute fullPath to the clipboard', () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByText('Copy path'));
    expect(writeText).toHaveBeenCalledWith('/tmp/demo/src/foo.ts');
  });

  it('Copy file contents writes the joined line text', () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByText('Copy file contents'));
    expect(writeText).toHaveBeenCalledWith('const a = 1\nconst b = 2');
  });

  it('toggling word wrap flips the .sheet-content nowrap class and persists', () => {
    const { container } = renderSheet();
    const content = () => container.querySelector('.sheet-content')!;
    expect(content().className).not.toContain('nowrap');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByText('Disable word wrap'));
    expect(content().className).toContain('nowrap');
    expect(localStorage.getItem('gian.sheet.wordwrap')).toBe('off');
  });

  it('shows the full path split into dir + filename in the path row', () => {
    const { container } = renderSheet();
    expect(container.querySelector('.sheet-path-row')).toBeTruthy();
    expect(container.querySelector('.sheet-path-dir')?.textContent).toBe('/tmp/demo/src/');
    expect(container.querySelector('.sheet-path-file')?.textContent).toBe('foo.ts');
  });

  it('the file icon slot doubles as the close button (no separate × column)', () => {
    const { container } = renderSheet();
    const close = container.querySelector('.sheet-tab .tab-lead .tab-close');
    expect(close).toBeTruthy();
    expect(container.querySelector('.sheet-tab .tab-x')).toBeNull();
    fireEvent.click(close!);
    expect(actions.closeTab).toHaveBeenCalledWith('t1');
  });

  it('middle-truncates a long tab name (tail kept, head ellipsizes)', () => {
    const longTab: SheetTab = { ...fileTab, id: 't2', name: 'apr-001-approval-card.test.tsx' };
    const { container } = render(
      <Sheet tabs={[longTab]} active={{ 0: 't2', 1: null }} actions={actions} />,
    );
    const head = container.querySelector('.sheet-tab .name-head')?.textContent ?? '';
    const tail = container.querySelector('.sheet-tab .name-tail')?.textContent ?? '';
    expect(head + tail).toBe('apr-001-approval-card.test.tsx');
    expect(tail).toBe('test.tsx');
  });

  it('preview tab has no pin element — italic name is the only indicator', () => {
    const previewTab: SheetTab = { ...fileTab, id: 't3', preview: true };
    const { container } = render(
      <Sheet tabs={[previewTab]} active={{ 0: 't3', 1: null }} actions={actions} />,
    );
    expect(container.querySelector('.tab-pin-inline')).toBeNull();
    expect(container.querySelector('.sheet-tab.preview')).toBeTruthy();
  });

  it('"Open with…" menu lists Finder/Terminal + configured apps (no default/browser); routes correctly', () => {
    const onOpenWith = vi.fn<(tab: SheetTab, target: SheetOpenWith) => void>();
    renderSheet({
      onOpenWith,
      externalEditors: [{ id: 'vsc', name: 'VS Code' }],
      onConfigureEditors: () => {},
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    // System actions kept in the menu…
    expect(screen.getByText('Reveal in Finder')).toBeTruthy();
    expect(screen.getByText('Open in Terminal')).toBeTruthy();
    // …default-app + browser are NOT in the menu (they're the smart Open button).
    expect(screen.queryByText('Open (default app)')).toBeNull();
    expect(screen.queryByText('Open in browser')).toBeNull();
    // Configured app + the Settings link.
    expect(screen.getByText('VS Code')).toBeTruthy();
    expect(screen.getByText(/configure apps/i)).toBeTruthy();

    fireEvent.click(screen.getByText('VS Code'));
    expect(onOpenWith).toHaveBeenCalledWith(fileTab, { kind: 'editor', id: 'vsc' });

    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    fireEvent.click(screen.getByText('Reveal in Finder'));
    expect(onOpenWith).toHaveBeenCalledWith(fileTab, { kind: 'system', name: 'finder' });
  });

  it('hides the "Open with…" control when no onOpenWith is provided', () => {
    renderSheet();
    expect(screen.queryByRole('button', { name: 'Open with…' })).toBeNull();
  });

  function openTab(name: string, id: string) {
    cleanup(); // unmount any previous render so there's a single Open button
    const onOpenWith = vi.fn<(tab: SheetTab, target: SheetOpenWith) => void>();
    const tab: SheetTab = { ...fileTab, id, name, fullPath: `/tmp/demo/${name}` };
    render(<Sheet tabs={[tab]} active={{ 0: id, 1: null }} actions={actions} onOpenWith={onOpenWith} onConfigureEditors={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    return { onOpenWith, tab };
  }

  // Built-in category defaults (no openApps configured): code → TextEdit;
  // web/images/pdf → new tab (system 'browser'); other → reveal in Finder.
  it('smart Open: a text/code file defaults to TextEdit', () => {
    const { onOpenWith, tab } = openTab('util.ts', 'c1');
    expect(onOpenWith).toHaveBeenCalledWith(tab, { kind: 'app', app: 'TextEdit' });
  });

  it('smart Open: pdf / images / html default to a new tab', () => {
    expect(openTab('doc.pdf', 'p1').onOpenWith).toHaveBeenCalledWith(expect.any(Object), { kind: 'system', name: 'browser' });
    expect(openTab('pic.png', 'i1').onOpenWith).toHaveBeenCalledWith(expect.any(Object), { kind: 'system', name: 'browser' });
    expect(openTab('page.html', 'w1').onOpenWith).toHaveBeenCalledWith(expect.any(Object), { kind: 'system', name: 'browser' });
  });

  it('smart Open: an unknown/binary file reveals in Finder', () => {
    const { onOpenWith, tab } = openTab('archive.zip', 'z1');
    expect(onOpenWith).toHaveBeenCalledWith(tab, { kind: 'system', name: 'finder' });
  });

  it('smart Open: honours a per-category app override (Settings)', () => {
    const onOpenWith = vi.fn<(tab: SheetTab, target: SheetOpenWith) => void>();
    const tab: SheetTab = { ...fileTab, id: 'o1', name: 'util.ts', fullPath: '/tmp/demo/util.ts' };
    render(<Sheet tabs={[tab]} active={{ 0: 'o1', 1: null }} actions={actions} onOpenWith={onOpenWith} openApps={{ code: 'Visual Studio Code' }} onConfigureEditors={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    expect(onOpenWith).toHaveBeenCalledWith(tab, { kind: 'app', app: 'Visual Studio Code' });
  });

  it('an image tab renders the file via <img> from /raw (not as text)', () => {
    const imgTab: SheetTab = {
      id: 'i1', pane: 0, name: 'logo.png', kind: 'file', icoKind: 'img', ico: '',
      previewKind: 'image', rawSrc: '/api/working_trees/ws%3Ademo/raw?path=logo.png',
      fullPath: '/tmp/demo/logo.png',
    };
    const { container } = render(
      <Sheet tabs={[imgTab]} active={{ 0: 'i1', 1: null }} actions={actions} />,
    );
    const img = container.querySelector('.sheet-image img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain('/raw?path=logo.png');
  });

  it('the "Open with…" menu shows app icons for Finder/Terminal + configured apps', () => {
    const onOpenWith = vi.fn<(tab: SheetTab, target: SheetOpenWith) => void>();
    const { container } = render(
      <Sheet tabs={[fileTab]} active={{ 0: 't1', 1: null }} actions={actions}
             onOpenWith={onOpenWith} externalEditors={[{ id: 'vsc', name: 'VS Code' }]} onConfigureEditors={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    const icons = Array.from(container.querySelectorAll('.sheet-act-menu .app-icon')) as HTMLImageElement[];
    // Finder, Terminal, VS Code each get an <img> icon (404 → fallback handled at runtime).
    const srcs = icons.map(i => i.getAttribute('src') ?? '');
    expect(srcs.some(s => s.includes('name=Finder'))).toBe(true);
    expect(srcs.some(s => s.includes('name=Terminal'))).toBe(true);
    expect(srcs.some(s => s.includes('name=VS%20Code'))).toBe(true);
  });
});
