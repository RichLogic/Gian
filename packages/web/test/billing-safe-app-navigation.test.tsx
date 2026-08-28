import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserAgentStatus, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { sessionContractFixture, stateSyncFixture } from './fixtures/ws-contract.js';
import { getMockWebSockets, mockFetch } from './setup.js';

const workspace: Workspace = {
  id: 'workspace-billing',
  name: 'Billing-safe workspace',
  path: '/tmp/billing-safe-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

const claudeAgent: UserAgentStatus = {
  id: 'agent-claude-1',
  name: 'Claude Code',
  proxy: 'claude',
  cliPath: '/bin/fake-claude',
  defaults: { model: '', thinking: '', mode: 'ask' },
  proxyName: 'Claude Code',
  ready: true,
  cli: {
    state: 'ready',
    path: '/bin/fake-claude',
    version: 'fixture-v1',
    source: 'path',
  },
  plugin: {
    state: 'ready',
    path: '/proxy/fake-claude',
    version: 'fixture-v1',
    source: 'development',
    defaults: { model: '', thinking: '', mode: 'ask' },
  },
  officialInstallUrl: 'https://example.invalid/claude',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BILLING-001: read-only App navigation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens Settings and a Claude Composer without dispatching a paid turn', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const sync = stateSyncFixture();
    sync.config.locale = 'en';
    sync.workspaces = [workspace];
    sync.sessions = [sessionContractFixture({
      id: 'claude-billing',
      name: 'Claude billing fixture',
      workspace_id: workspace.id,
      executor: 'claude',
    })];

    mockFetch(async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      requests.push({ method, url });

      if (url === '/api/auth/me') return json({ user: 'fixture-user' });
      if (url === '/api/auth/ws-token') return json({ token: 'fixture-token' });
      if (url === '/api/settings') return json(sync.config);
      if (url === '/api/agents' || url === '/api/agents?refresh=1') {
        return json({ agents: [claudeAgent] });
      }
      if (url === '/api/apps') return json({ apps: [] });
      if (url === '/api/workspaces') return json([workspace]);
      if (url === '/api/sessions') return json(sync.sessions);
      if (url === '/api/tasks') return json([]);
      if (url === '/api/working_trees') return json([]);
      if (url === '/api/sessions/claude-billing/events') {
        return json({ events: [], nextCursor: null, hasMore: false });
      }
      if (url === '/api/proxy/claude/models') return json({ models: [] });
      if (url === '/api/proxy/claude/capabilities') {
        return json({ protocolVersion: 'fixture-v1', models: [], modes: [], slashCommands: [] });
      }
      if (url === `/api/proxy/claude/slash?workspace=${workspace.id}`) {
        return json({ commands: [] });
      }
      return json({ error: `Unexpected fixture request: ${method} ${url}` }, 404);
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(getMockWebSockets()).toHaveLength(1));
    const socket = getMockWebSockets()[0]!;
    act(() => socket.fakeOpen());
    act(() => socket.fakeMessage({ type: 'auth_ok', user: 'fixture-user' }));
    act(() => socket.fakeMessage(sync));

    await user.click(await screen.findByTestId('mode-button'));
    await user.click(await screen.findByTestId('mode-option-sessions'));
    await user.click(await screen.findByTestId('session-row-claude-billing'));
    expect(await screen.findByRole('textbox', { name: 'Message…' })).toBeInTheDocument();

    await waitFor(() => {
      expect(requests.map(request => request.url)).toContain('/api/proxy/claude/models');
      expect(requests.map(request => request.url)).toContain('/api/proxy/claude/capabilities');
    });

    await user.click(screen.getByTestId('dock-settings'));
    expect(await screen.findByTestId('settings-body')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'AI Agents' }));
    expect(await screen.findByDisplayValue('Claude Code')).toBeInTheDocument();

    // Startup, Settings, and Composer may discover metadata, but this whole
    // read-only path must not cross either mutation boundary that can start a
    // provider turn: HTTP writes or a message/session WS command.
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(requests.some(request => request.url.includes('-p'))).toBe(false);

    const frameTypes = socket.parsedSent<{ type?: string }>().map(frame => frame.type);
    expect(new Set(frameTypes)).toEqual(new Set(['auth', 'events:subscribe']));
    expect(frameTypes).not.toContain('message:send');
    expect(frameTypes).not.toContain('session:create');
  });
});
