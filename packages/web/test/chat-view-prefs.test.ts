// Coverage for traceability row:
//   CHATVIEW-001 — Configurable chat-area runtime tabs (claude -p / tty +
//                  optional CLI). Pure helpers decide tab visibility, the
//                  open-time surface, and the re-seeded CLI default.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_VIEW,
  planCreatedSessionFirstMessage,
  reseedClaudeCli,
  resolveChatView,
  runtimeChatSurface,
  runtimeForSurface,
  runtimeTabs,
  type ChatViewConfig,
} from '../src/session-routing.js';

const TTY: ChatViewConfig = { claude_chat_surface: 'tty', claude_chat_cli: true, codex_chat_cli: false };
const STRUCTURED: ChatViewConfig = { claude_chat_surface: 'structured', claude_chat_cli: false, codex_chat_cli: false };

describe('CHATVIEW-001: resolveChatView', () => {
  it('returns defaults for null/undefined', () => {
    expect(resolveChatView(null)).toEqual(DEFAULT_CHAT_VIEW);
    expect(resolveChatView(undefined)).toEqual(DEFAULT_CHAT_VIEW);
  });

  it('default = tty + claude CLI on + codex CLI off', () => {
    expect(DEFAULT_CHAT_VIEW).toEqual({
      claude_chat_surface: 'tty',
      claude_chat_cli: true,
      codex_chat_cli: false,
    });
  });

  it('fills missing fields from defaults', () => {
    expect(resolveChatView({ claude_chat_surface: 'structured' })).toEqual({
      claude_chat_surface: 'structured',
      claude_chat_cli: true,
      codex_chat_cli: false,
    });
  });
});

describe('CHATVIEW-001: reseedClaudeCli', () => {
  it('tty seeds CLI on, structured seeds CLI off', () => {
    expect(reseedClaudeCli('tty')).toBe(true);
    expect(reseedClaudeCli('structured')).toBe(false);
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

describe('CHATVIEW-001: runtimeTabs', () => {
  it('claude tty + cli → Chat(beta) · CLI', () => {
    expect(runtimeTabs('claude', { ...TTY, claude_chat_cli: true })).toEqual([
      { surface: 'beta', label: 'chat' },
      { surface: 'cli', label: 'cli' },
    ]);
  });

  it('claude tty, no cli → single Chat(beta)', () => {
    expect(runtimeTabs('claude', { ...TTY, claude_chat_cli: false })).toEqual([
      { surface: 'beta', label: 'chat' },
    ]);
  });

  it('claude structured + cli → Chat(chat) · CLI', () => {
    expect(runtimeTabs('claude', { ...STRUCTURED, claude_chat_cli: true })).toEqual([
      { surface: 'chat', label: 'chat' },
      { surface: 'cli', label: 'cli' },
    ]);
  });

  it('claude structured, no cli → single Chat(chat)', () => {
    expect(runtimeTabs('claude', STRUCTURED)).toEqual([
      { surface: 'chat', label: 'chat' },
    ]);
  });

  it('codex cli on → Chat(chat) · CLI', () => {
    expect(runtimeTabs('codex', { ...STRUCTURED, codex_chat_cli: true })).toEqual([
      { surface: 'chat', label: 'chat' },
      { surface: 'cli', label: 'cli' },
    ]);
  });

  it('codex cli off → single Chat(chat)', () => {
    expect(runtimeTabs('codex', STRUCTURED)).toEqual([
      { surface: 'chat', label: 'chat' },
    ]);
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
