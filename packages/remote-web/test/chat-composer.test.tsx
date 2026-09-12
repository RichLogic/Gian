import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateCanonicalId } from '@gian/remote-protocol';
import { renderApp } from './render-app.js';
import { sampleCapabilities, sampleSessions, sampleTasks, sampleTranscript } from '../src/controller/fixture.js';

describe('chat + composer (B5)', () => {
  it('renders the transcript through @gian/chat-ui (msg/trow classes)', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(document.querySelector('.transcript .msg.user')).not.toBeNull();
    expect(document.querySelector('.transcript .trow')).not.toBeNull();
  });

  it('opens a historical attachment with its opaque file handle', async () => {
    const user = userEvent.setup();
    const attachmentId = generateCanonicalId();
    const transcript = sampleTranscript().map((item) => item.kind === 'user'
      ? {
          ...item,
          attachments: [{
            name: 'screen.png',
            mime: 'image/png',
            url: attachmentId,
            size: 128,
          }],
        }
      : item);
    const { controller } = renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: sampleCapabilities(),
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': transcript },
      } } },
      viewport: 'wide',
    });
    controller.autoResolveFile = false;

    await user.click(screen.getByRole('button', { name: /screen\.png/ }));
    expect(controller.state.fileViewer).toEqual({
      status: 'loading',
      handle: { id: attachmentId, sessionId: 's-1', label: 'screen.png' },
    });
  });

  it('shows the canonical Session model and opens its choices on narrow layouts', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'narrow' });
    const picker = screen.getByRole('button', { name: /gpt-5\.3-codex/ });
    expect(picker).toHaveTextContent('gpt-5.3-codex · Medium');
    expect(picker).not.toHaveTextContent(/^Codex/);

    await user.click(picker);
    const menu = screen.getByRole('menu', { name: 'Model / Thinking / Fast' });
    expect(Array.from(menu.querySelectorAll('[data-config-row]')).map((row) => (
      row.getAttribute('data-config-row')
    ))).toEqual(['model', 'thinking', 'fast']);
    expect(within(menu).getByRole('menuitem', { name: /Model.*GPT-5\.3 Codex/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Thinking.*Medium/ })).toBeInTheDocument();
    expect(within(menu).getByRole('switch', { name: 'Fast' })).toHaveAttribute('aria-checked', 'false');
  });

  it('opens the model menu on wide layouts and dispatches the selected model', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });

    await user.click(screen.getByRole('button', { name: /gpt-5\.3-codex/ }));
    const menu = screen.getByRole('menu', { name: 'Model / Thinking / Fast' });
    expect(menu).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Model.*GPT-5\.3 Codex/ }));
    expect(screen.getByRole('menuitemradio', { name: /GPT-5\.3 Codex/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-5\.2 Codex/ }));
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
  });

  it('dispatches thinking and mode changes and waits for canonical settlement', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide', locale: 'en' });
    const picker = screen.getByRole('button', { name: /gpt-5\.3-codex/ });

    await user.click(picker);
    await user.click(screen.getByRole('menuitem', { name: /Thinking.*Medium/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.thinking).toBe('medium');
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.thinking).toBe('high');

    await user.click(picker);
    const fast = screen.getByRole('switch', { name: 'Fast' });
    expect(fast).toHaveAttribute('aria-checked', 'false');
    await user.click(fast);
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBeNull();
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBe('fast');
    expect(screen.getByRole('switch', { name: 'Fast' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('switch', { name: 'Fast' }));
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBeNull();
  });

  it('shows an explicit loading state before a Session history page arrives', () => {
    renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: sampleCapabilities(),
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: {},
      } } },
      viewport: 'wide',
    });

    expect(screen.getByRole('status')).toHaveTextContent('Loading message history…');
    expect(screen.queryByText('say hi to start the conversation')).toBeNull();
  });

  it('active turn: the merged primary button is Stop while the input is empty', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const stop = screen.getByRole('button', { name: /Stop/ });
    expect(stop.className).toContain('danger');
  });

  it('active turn + text: primary becomes Send and the send queues by default', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const before = controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries.length;
    const input = screen.getByRole('textbox');
    await user.type(input, 'hook 里加超时保护');
    const send = screen.getByRole('button', { name: /发送/ });
    await user.click(send);
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
    controller.test.resolveAll();
    const after = controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries;
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.text).toBe('hook 里加超时保护');
    // draft cleared on acceptance
    expect(controller.state.drafts['s-1']?.text ?? '').toBe('');
  });

  it('idle session: Send starts a turn (no queue append)', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    controller.actions.selectSession('s-2'); // visible Doing session, no active turn
    await user.type(screen.getByRole('textbox'), '帮我起个 checklist');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    controller.test.resolveAll();
    const session = controller.state.sessions.find((s) => s.id === 's-2')!;
    expect(session.status).toBe('running');
    expect(session.active_turn).toBeTruthy();
    expect(session.queue.entries).toHaveLength(0);
  });

  it('Stop ends the active turn on canonical success', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
    controller.test.resolveAll();
    expect(controller.state.sessions.find((s) => s.id === 's-1')!.active_turn).toBeUndefined();
  });

  it('offline keeps the draft editable but disables every mutation', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { connection: { kind: 'host_offline', lastSeenAt: Date.now() } },
      viewport: 'wide',
    });
    // Empty input + running turn → the merged button is Stop, disabled offline.
    expect(screen.getByRole('button', { name: /Stop/ })).toBeDisabled();
    const input = screen.getByRole('textbox');
    await user.type(input, '草稿保留');
    expect(controller.state.drafts['s-1']!.text).toBe('草稿保留');
    // With text the merged button becomes Send, still disabled offline.
    expect(screen.getByRole('button', { name: /发送/ })).toBeDisabled();
    // The configuration menu remains inspectable and closable while its
    // mutation controls stay disabled.
    const picker = screen.getByRole('button', { name: /gpt-5\.3-codex/ });
    expect(picker).toBeEnabled();
    await user.click(picker);
    expect(screen.getByRole('switch', { name: 'Fast' })).toBeDisabled();
    await user.click(picker);
    expect(screen.queryByRole('menu', { name: 'Model / Thinking / Fast' })).toBeNull();
    // a crafted direct action call is refused too
    controller.actions.sendDraft('s-1');
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
  });

  it('attachment/context/document chips can be added and removed in any mode', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: '添加附件 / context / 文档' }));
    await user.click(screen.getByRole('menuitem', { name: '附件' }));
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    await user.upload(fileInput as HTMLInputElement, new File(['x'], 'attachment.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: '添加附件 / context / 文档' }));
    await user.click(screen.getByRole('menuitem', { name: 'Context 条目' }));
    await user.click(screen.getByRole('button', { name: '添加附件 / context / 文档' }));
    await user.click(screen.getByRole('menuitem', { name: '文档' }));
    await waitFor(() => expect(controller.state.drafts['s-1']?.attachments).toHaveLength(1));
    const draft = controller.state.drafts['s-1']!;
    expect(draft.attachments).toHaveLength(1);
    expect(draft.contextItems).toHaveLength(1);
    expect(draft.document).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove attachment.png' }));
    expect(controller.state.drafts['s-1']!.attachments).toHaveLength(0);
  });

  it('production capabilities hide context and document entries that would fail on Host', async () => {
    const user = userEvent.setup();
    const caps = {
      ...sampleCapabilities(),
      'composer.context': { state: 'unsupported' },
      'composer.document': { state: 'unsupported' },
    };
    renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: caps,
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': sampleTranscript() },
      } } },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('button', { name: '添加附件 / context / 文档' }));
    expect(screen.getByRole('menuitem', { name: '附件' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Context 条目' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '文档' })).toBeNull();
  });

  it('capability unsupported hides the attach entry; denied send disables Send', () => {
    const caps = sampleCapabilities();
    caps['attachment.upload'] = { state: 'unsupported' };
    (caps as Record<string, { state: string }>)['composer.context'] = { state: 'unsupported' };
    (caps as Record<string, { state: string }>)['composer.document'] = { state: 'unsupported' };
    caps['session.send'] = { state: 'denied', reason: 'grant missing' };
    renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: caps,
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': sampleTranscript() },
      } } },
      viewport: 'wide',
    });
    expect(screen.queryByRole('button', { name: '添加附件 / context / 文档' })).toBeNull();
    // session.stop remains supported → the merged button (Stop here) stays enabled
    expect(screen.getByRole('button', { name: /Stop/ })).toBeEnabled();
  });

  it('denied session.send disables Send even with text', async () => {
    const user = userEvent.setup();
    const caps = sampleCapabilities();
    caps['session.send'] = { state: 'denied', reason: 'grant missing' };
    caps['session.stop'] = { state: 'supported' };
    const { controller } = renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: caps,
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': sampleTranscript() },
      } } },
      viewport: 'wide',
    });
    await user.type(screen.getByRole('textbox'), 'hello');
    const send = screen.getByRole('button', { name: /发送/ });
    expect(send).toBeDisabled();
    controller.actions.sendDraft('s-1');
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
  });

  it('stale transcript never presents streaming affordances', () => {
    renderApp({
      scenario: { connection: { kind: 'relay_reconnecting', attempt: 2 } },
      viewport: 'wide',
    });
    expect(document.querySelector('.rw-chat-root.rw-stale')).not.toBeNull();
  });

  it('unknown outcome shows 状态待确认 with refresh — no blind retry', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.type(screen.getByRole('textbox'), '测试 unknown');
    controller.test.scriptSend('unknown');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    controller.test.resolveAll();
    expect(screen.getByText(/状态待确认/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重试|Retry/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(screen.queryByText(/状态待确认/)).toBeNull();
  });
});
