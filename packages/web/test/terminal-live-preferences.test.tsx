import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import type { TerminalWire } from '../src/components/terminal-wire.js';

const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    disposed: boolean;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    disposed = false;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xtermState.instances.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    onData(): { dispose(): void } { return { dispose() {} }; }
    write(): void {}
    reset(): void {}
    dispose(): void { this.disposed = true; }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon { fit(): void {} },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

import { Terminal } from '../src/components/Terminal.js';

describe('Terminal live preferences', () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
  });

  it('updates xterm options without replacing the xterm instance or respawning its PTY', () => {
    const spawn = vi.fn();
    const wire: TerminalWire = {
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      requestReplay: vi.fn(),
      spawn,
      subscribe: vi.fn(() => vi.fn()),
    };
    const view = render(
      <Terminal
        instanceKey="term:one"
        wire={wire}
        preferences={{ ...DEFAULT_TERMINAL_PREFERENCES }}
      />,
    );

    expect(xtermState.instances).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    view.rerender(
      <Terminal
        instanceKey="term:one"
        wire={wire}
        preferences={{
          ...DEFAULT_TERMINAL_PREFERENCES,
          font_size: 17,
          cursor_blink: false,
          scrollback_lines: 10_000,
        }}
      />,
    );

    expect(xtermState.instances).toHaveLength(1);
    expect(xtermState.instances[0]?.options).toMatchObject({
      fontSize: 17,
      cursorBlink: false,
      scrollback: 10_000,
    });
    expect(xtermState.instances[0]?.disposed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refits and forwards a changed PTY size when the packaged window resizes', () => {
    const sendResize = vi.fn();
    const wire: TerminalWire = {
      sendInput: vi.fn(),
      sendResize,
      requestReplay: vi.fn(),
      spawn: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    render(
      <Terminal
        instanceKey="term:resize"
        wire={wire}
        preferences={{ ...DEFAULT_TERMINAL_PREFERENCES }}
      />,
    );
    const before = sendResize.mock.calls.length;
    xtermState.instances[0]!.cols = 101;

    act(() => window.dispatchEvent(new Event('resize')));

    expect(sendResize).toHaveBeenCalledTimes(before + 1);
    expect(sendResize).toHaveBeenLastCalledWith(101, 24);
  });
});
