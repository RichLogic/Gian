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

  it('narrow layouts collapse the config controls into the proxy icon (2026-09-15 framework sync)', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'narrow' });
    // Icon-only trigger: no model text, opens the combined sheet at its root.
    const picker = screen.getByRole('button', { name: 'Model / Thinking / Fast' });
    expect(picker).not.toHaveTextContent(/gpt-5\.3-codex/);
    // The audit chip stays but drops its label.
    expect(screen.getByTestId('rw-approval-chip')).not.toHaveTextContent(/Ask/);

    await user.click(picker);
    const menu = screen.getByRole('menu', { name: 'Model / Thinking / Fast' });
    expect(Array.from(menu.querySelectorAll('[data-config-row]')).map((row) => (
      row.getAttribute('data-config-row')
    ))).toEqual(['model', 'thinking', 'fast']);
    expect(within(menu).getByRole('menuitem', { name: /Model.*GPT-5\.3 Codex/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Thinking.*Medium/ })).toBeInTheDocument();
    expect(within(menu).getByRole('switch', { name: 'Fast' })).toHaveAttribute('aria-checked', 'false');
  });

  it('opens the model list directly from the wide model chip and dispatches the selection', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });

    await user.click(screen.getByRole('button', { name: /gpt-5\.3-codex/ }));
    // Deep-linked straight into the model page — no root-row hop.
    expect(screen.getByRole('menuitemradio', { name: /GPT-5\.3 Codex/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-5\.2 Codex/ }));
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
  });

  it('dispatches thinking and fast changes from their wide-bar chips and waits for canonical settlement', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide', locale: 'en' });

    await user.click(screen.getByTestId('rw-thinking-chip'));
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.thinking).toBe('medium');
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.thinking).toBe('high');

    const fast = screen.getByTestId('rw-fast-chip');
    expect(fast).toHaveAttribute('aria-pressed', 'false');
    await user.click(fast);
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBeNull();
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBe('fast');
    expect(screen.getByTestId('rw-fast-chip')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('rw-fast-chip'));
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.service_tier).toBeNull();
  });

  it('audit chip lists the proxy modes and settles approval_mode (2026-09-15 audit-mode sync)', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide', locale: 'en' });
    const chip = screen.getByTestId('rw-approval-chip');
    expect(chip).toHaveTextContent('Ask for approval');

    await user.click(chip);
    const menu = screen.getByRole('menu', { name: 'Approval mode' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Ask for approval' }))
      .toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Full access' }));
    // The chip keeps the previous label until the canonical settle arrives.
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.approval_mode)
      .not.toBe('full-access');
    controller.test.resolveAll();
    expect(controller.state.sessions.find((session) => session.id === 's-1')?.approval_mode)
      .toBe('full-access');
    expect(screen.getByTestId('rw-approval-chip')).toHaveTextContent('Full access');
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
    expect(screen.getByTestId('rw-fast-chip')).toBeDisabled();
    expect(screen.getByTestId('rw-approval-chip')).toBeDisabled();
    await user.click(picker);
    expect(screen.getByRole('menu', { name: 'Model / Thinking / Fast' })).toBeInTheDocument();
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

  it('image attachment chips read image<N> by draft position; files keep their names', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    const attach = async (file: File) => {
      await user.click(screen.getByRole('button', { name: '添加附件 / context / 文档' }));
      await user.click(screen.getByRole('menuitem', { name: '附件' }));
      await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    };
    await attach(new File(['x'], 'shot.png', { type: 'image/png' }));
    await attach(new File(['x'], 'notes.txt', { type: 'text/plain' }));

    await waitFor(() => {
      expect(document.querySelectorAll('.composer-chip[data-kind="attachment"]')).toHaveLength(2);
    });
    const chips = document.querySelectorAll('.composer-chip[data-kind="attachment"]');
    // N = 1-based position among the draft's attachments — the same
    // numbering the main composer applies to image chips at send time.
    expect(chips[0]).toHaveTextContent('image1');
    expect(chips[1]).toHaveTextContent('notes.txt');
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
