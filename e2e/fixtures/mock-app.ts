import type { Page } from '@playwright/test';
import type { Bot, Session, SystemConfig, Workspace } from '@gian/shared';

export function mockConfig(partial: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1',
    port: Number(process.env.GIAN_HOST_PORT ?? process.env.GIAN_PORT ?? '8991'),
    workspace_root: '/tmp/gian-e2e',
    public_url: '',
    tunnel_mode: 'none',
    tunnel_id: '',
    force_https: false,
    theme: 'warm',
    accent: 'plum',
    density: 'cozy',
    locale: 'en',
    default_claude_model: '',
    default_claude_effort: '',
    default_codex_model: '',
    default_codex_effort: '',
    auth_username: 'dev',
    ...partial,
  };
}

export function mockWorkspace(partial: Partial<Workspace> = {}): Workspace {
  const now = new Date().toISOString();
  return {
    id: 'ws-e2e',
    name: 'e2e-workspace',
    path: '/tmp/gian-e2e/workspace',
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

export function mockSession(partial: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: 'session-e2e',
    name: 'Mock session',
    type: 'coding',
    workspace_id: 'ws-e2e',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    thinking_effort: null,
    active_channel: 'web',
    status: 'new',
    archived: 0,
    pinned_at: null,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

export async function installMockApp(
  page: Page,
  input: {
    config?: SystemConfig;
    workspaces?: Workspace[];
    sessions?: Session[];
    bots?: Bot[];
  } = {},
): Promise<void> {
  const config = input.config ?? mockConfig();
  const workspaces = input.workspaces ?? [mockWorkspace()];
  const sessions = input.sessions ?? [];
  const bots = input.bots ?? [];

  await page.addInitScript(({ config, workspaces, sessions, bots }) => {
    const sent: string[] = [];
    const sockets: EventTarget[] = [];
    Object.defineProperty(window, '__gianWsSent', {
      value: sent,
      configurable: true,
    });
    Object.defineProperty(window, '__gianEmitWsMessage', {
      value: (message: unknown) => {
        for (const socket of sockets) {
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }
      },
      configurable: true,
    });

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      readyState = FakeWebSocket.CONNECTING;
      private bootstrapped = false;

      constructor(url: string) {
        super();
        this.url = url;
        sockets.push(this);
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
          // Keep the fixture deterministic even when the token fetch resolves
          // after the synthetic socket's open task.
          setTimeout(() => this.bootstrap(), 0);
        }, 0);
      }

      send(data: string): void {
        sent.push(data);
        let parsed: { type?: string };
        try {
          parsed = JSON.parse(data) as { type?: string };
        } catch {
          return;
        }
        if (parsed.type === 'auth') {
          this.bootstrap();
        }
      }

      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'closed', wasClean: true }));
      }

      private emit(message: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
      }

      private bootstrap(): void {
        if (this.bootstrapped) return;
        this.bootstrapped = true;
        this.emit({ type: 'auth_ok', user: 'dev' });
        this.emit({
          type: 'state_sync',
          runner: {
            host: config.host,
            latency: 0,
            started_ago: '0s',
            agents: 0,
            disk: '?',
            codex_version: '?',
            cc_version: '?',
            ws_root: config.workspace_root,
          },
            sessions,
            workspaces,
            tasks: [],
            bots,
          approvals: [],
          config,
        });
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      value: FakeWebSocket,
      configurable: true,
    });
  }, { config, workspaces, sessions, bots });

  await page.route('**/api/auth/ws-token', route => route.fulfill({ json: { token: 'dev-token' } }));
  await page.route('**/api/settings', route => route.fulfill({ json: config }));
  await page.route('**/api/workspaces', route => route.fulfill({ json: workspaces }));
  await page.route('**/api/sessions', route => route.fulfill({ json: sessions }));
  await page.route('**/api/sessions?archived=true', route => route.fulfill({ json: [] }));
  await page.route('**/api/bots', route => route.fulfill({ json: bots }));
  await page.route('**/api/working_trees', route => {
    route.fulfill({
      json: workspaces.map(ws => ({
        id: `ws:${ws.id}`,
        kind: 'workspace',
        label: ws.name,
        path: ws.path,
        branch: null,
        workspace_id: ws.id,
        workspace_name: ws.name,
        session_id: null,
        session_name: null,
      })),
    });
  });
  await page.route('**/api/working_trees/*/changed', route => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/*/events', route => route.fulfill({ json: [] }));
  await page.route('**/api/proxy/*/models', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/api/proxy/*/slash**', route => route.fulfill({ json: { commands: [] } }));
  // The new-session agent picker is data-driven; keep it deterministic.
  await page.route('**/api/agents', route => route.fulfill({
    json: {
      agents: [
        { id: 'codex', name: 'Codex', ready: true, cli: { state: 'ready', path: '/bin/codex', version: '1.0.0', source: 'path' }, proxy: { state: 'ready', path: '/proxy/codex', version: '0.1.0', source: 'github-release' }, officialInstallUrl: 'https://example.invalid' },
        { id: 'claude', name: 'Claude Code', ready: true, cli: { state: 'ready', path: '/bin/claude', version: '1.0.0', source: 'path' }, proxy: { state: 'ready', path: '/proxy/claude', version: '0.1.0', source: 'github-release' }, officialInstallUrl: 'https://example.invalid' },
        { id: 'kimi', name: 'Kimi Code', ready: true, cli: { state: 'ready', path: '/bin/kimi', version: '1.0.0', source: 'path' }, proxy: { state: 'ready', path: '/proxy/kimi', version: '0.1.0', source: 'github-release' }, officialInstallUrl: 'https://example.invalid' },
      ],
    },
  }));
}

export async function sentWsMessages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const raw = (window as unknown as { __gianWsSent?: string[] }).__gianWsSent ?? [];
    return raw.map(item => JSON.parse(item) as Record<string, unknown>);
  });
}

export async function emitWsMessage(page: Page, message: unknown): Promise<void> {
  await page.evaluate((message) => {
    const emit = (window as unknown as { __gianEmitWsMessage?: (msg: unknown) => void }).__gianEmitWsMessage;
    if (!emit) throw new Error('mock websocket emitter is not installed');
    emit(message);
  }, message);
}
