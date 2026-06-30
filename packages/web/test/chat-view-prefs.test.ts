// Coverage for traceability row:
//   CHATVIEW-001 — Configurable chat-area runtime tabs (claude -p / tty +
//                  optional CLI). Pure helpers decide tab visibility, the
//                  open-time surface, and the re-seeded CLI default.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_VIEW,
  planCreatedSessionFirstMessage,
  resolveChatView,
  runtimeChatSurface,
  runtimeForSurface,
  runtimeTabs,
  type ChatViewConfig,
} from '../src/session-routing.js';

const TTY: ChatViewConfig = { claude_chat_surface: 'tty' };
const STRUCTURED: ChatViewConfig = { claude_chat_surface: 'structured' };

describe('CHATVIEW-001: resolveChatView', () => {
  it('returns defaults for null/undefined', () => {
    expect(resolveChatView(null)).toEqual(DEFAULT_CHAT_VIEW);
    expect(resolveChatView(undefined)).toEqual(DEFAULT_CHAT_VIEW);
  });

  it('default = tty (CLI is no longer a stored pref)', () => {
    expect(DEFAULT_CHAT_VIEW).toEqual({ claude_chat_surface: 'tty' });
  });

  it('fills the missing surface from defaults', () => {
    expect(resolveChatView({})).toEqual({ claude_chat_surface: 'tty' });
    expect(resolveChatView({ claude_chat_surface: 'structured' })).toEqual({
      claude_chat_surface: 'structured',
    });
  });
});

describe('CHATVIEW-001: runtimeForSurface', () => {
  it('chat is structured; beta/cli are tty', () => {
    expect(runtimeForSurface('chat')).toBe('structured');
    expect(runtimeForSurface('beta')).toBe('tty');
    expect(runtimeForSurface('cli')).toBe('tty');
  });
});

describe('CHATVIEW-001: runtimeChatSurface', () => {
  it('claude follows config; codex always chat', () => {
    expect(runtimeChatSurface('claude', TTY)).toBe('beta');
    expect(runtimeChatSurface('claude', STRUCTURED)).toBe('chat');
    expect(runtimeChatSurface('codex', TTY)).toBe('chat');
    expect(runtimeChatSurface('codex', STRUCTURED)).toBe('chat');
  });
});

describe('CHATVIEW-001: runtimeTabs (CLI derived from runtime, not a toggle)', () => {
  it('claude tty → Chat(beta) · CLI', () => {
    expect(runtimeTabs('claude', TTY)).toEqual([
      { surface: 'beta', label: 'chat' },
      { surface: 'cli', label: 'cli' },
    ]);
  });

  it('claude structured (claude -p) → single Chat(chat), no CLI', () => {
    expect(runtimeTabs('claude', STRUCTURED)).toEqual([
      { surface: 'chat', label: 'chat' },
    ]);
  });

  it('codex never gets a CLI tab, on either surface', () => {
    expect(runtimeTabs('codex', TTY)).toEqual([{ surface: 'chat', label: 'chat' }]);
    expect(runtimeTabs('codex', STRUCTURED)).toEqual([{ surface: 'chat', label: 'chat' }]);
  });
});

describe('CHATVIEW-001: planCreatedSessionFirstMessage honors the Claude surface', () => {
  it('claude + tty → switch to TTY (default arg preserved)', () => {
    expect(planCreatedSessionFirstMessage('claude', '  hi  ', 'tty')).toEqual({
      switchToTty: true,
      ttyText: 'hi',
      structuredText: null,
      seedOptimisticEcho: false,
    });
    // Legacy 2-arg call still defaults to tty.
    expect(planCreatedSessionFirstMessage('claude', 'hi').switchToTty).toBe(true);
  });

  it('claude + structured → stay structured like codex', () => {
    expect(planCreatedSessionFirstMessage('claude', '  hi  ', 'structured')).toEqual({
      switchToTty: false,
      ttyText: null,
      structuredText: 'hi',
      seedOptimisticEcho: true,
    });
  });

  it('codex stays structured regardless of the surface arg', () => {
    expect(planCreatedSessionFirstMessage('codex', 'hi', 'tty')).toEqual({
      switchToTty: false,
      ttyText: null,
      structuredText: 'hi',
      seedOptimisticEcho: true,
    });
  });
});
