import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatContextPanel } from '../src/components/ChatContextPanel.js';
import { PlanChip } from '../src/components/PlanChip.js';
import {
  BrowserLinkOpenContext,
  ChatPanelOpenContext,
} from '../src/presentation/chat-panel.js';
import { AgentSpawnRow, MarkdownText } from '../src/transcript/items.js';
import type { AgentSpawnItem } from '../src/types.js';

function kimiAgent(overrides: Partial<AgentSpawnItem> = {}): AgentSpawnItem {
  return {
    kind: 'agent-spawn',
    id: 'agent-call-1',
    provider: 'kimi',
    agentId: 'agent-native-1',
    taskId: 'task-native-1',
    description: 'Inspect the event reducer',
    status: 'done',
    agentType: 'coder',
    background: true,
    input: { prompt: 'Read the reducer and report every lifecycle risk.' },
    output: 'Found and repaired one stale status transition.',
    startedAt: 1_000,
    updatedAt: 6_000,
    completedAt: 6_000,
    ts: 1_000,
    turn: 3,
    ...overrides,
  };
}

describe('chat-owned panel 2 detail', () => {
  it('keeps Plan inline with no separate Chat panel action', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <ChatPanelOpenContext.Provider value={open}>
        <PlanChip
          sessionId="session-1"
          planText={'## Plan\n- [ ] inspect'}
          items={[]}
        />
      </ChatPanelOpenContext.Provider>,
    );

    await user.click(screen.getByRole('button', { name: /Plan/i }));
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();
    // The plan panel deliberately has NO "open in chat panel" action — the
    // inline overlay is the only plan surface.
    expect(screen.queryByRole('button', { name: 'Open plan details' })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens an Agent from both the context list and transcript row', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const item = kimiAgent();
    const { unmount } = render(
      <ChatPanelOpenContext.Provider value={open}>
        <PlanChip sessionId="session-1" items={[item]} />
      </ChatPanelOpenContext.Provider>,
    );

    await user.click(screen.getByRole('button', { name: /Agent/i }));
    await user.click(screen.getByRole('button', { name: /Inspect the event reducer/i }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'agent', id: '3:agent-spawn:agent-call-1' });

    unmount();
    render(
      <ChatPanelOpenContext.Provider value={open}>
        <AgentSpawnRow item={item} />
      </ChatPanelOpenContext.Provider>,
    );
    await user.click(screen.getByRole('button', { name: /Inspect the event reducer/i }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'agent', id: '3:agent-spawn:agent-call-1' });
  });

  it('shows the provider-native Kimi fields without inventing missing metrics', () => {
    render(
      <ChatContextPanel
        target={{ kind: 'agent', id: '3:agent-spawn:agent-call-1', sessionId: 'session-1' }}
        items={[kimiAgent()]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Kimi')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('Background')).toBeInTheDocument();
    expect(screen.getByText('agent-native-1')).toBeInTheDocument();
    expect(screen.getByText('task-native-1')).toBeInTheDocument();
    expect(screen.getByText(/Read the reducer/)).toBeInTheDocument();
    expect(screen.getByText(/Found and repaired/)).toBeInTheDocument();
    expect(screen.queryByText(/tokens/i)).not.toBeInTheDocument();
  });

  it('renders full transcript detail without assigning it to a workbench rail', () => {
    render(
      <ChatContextPanel
        target={{
          kind: 'transcript-detail',
          title: 'Tool: Asking user questions',
          text: '{\n  "question": "Which path?"\n}',
          sourceId: '4:tool:ask',
          sessionId: 'session-1',
        }}
        items={[]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('complementary', { name: 'Tool: Asking user questions' })).toBeInTheDocument();
    expect(screen.getByText(/Which path/)).toHaveClass('chat-context-detail');
  });
});

describe('content-owned link routing', () => {
  it('routes web links to the Browser owner', async () => {
    const user = userEvent.setup();
    const openBrowser = vi.fn();
    render(
      <BrowserLinkOpenContext.Provider value={openBrowser}>
        <MarkdownText>{'[Gian docs](https://example.com/docs)'}</MarkdownText>
      </BrowserLinkOpenContext.Provider>,
    );

    await user.click(screen.getByRole('link', { name: 'Gian docs' }));
    expect(openBrowser).toHaveBeenCalledWith('https://example.com/docs');
  });
});
