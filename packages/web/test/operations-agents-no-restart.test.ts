import { beforeEach, describe, expect, it, vi } from 'vitest';

const restartApp = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    createAgent: vi.fn(async (input) => ({
      id: 'agent-1',
      name: input.name,
      pluginId: input.pluginId ?? 'claude',
      proxy: input.proxy ?? 'claude',
      cliPath: input.cliPath ?? null,
      defaults: input.defaults ?? { model: '', thinking: '', mode: '' },
      ready: true,
    })),
    deleteAgent: vi.fn(async () => true),
    updateAgent: vi.fn(async (_id, patch) => ({
      id: 'agent-1',
      name: 'Kept',
      pluginId: 'claude',
      proxy: patch.proxy ?? 'claude',
      cliPath: patch.cliPath ?? '/bin/claude',
      defaults: { model: '', thinking: '', mode: '' },
      ready: true,
    })),
  };
});

vi.mock('../src/desktop-bridge.js', () => ({
  desktopBridge: () => ({ restartApp }),
}));

import { registry } from '../src/operations/registry.js';
import '../src/operations/agents.js';

describe('Agent mutations do not restart Desktop', () => {
  beforeEach(() => {
    restartApp.mockReset();
  });

  it('create/delete/path/switch never call restartApp and carry no restart input', async () => {
    const created = await registry.get('agent.create').execute({
      name: 'No Restart',
      pluginId: 'io.gian.fixture',
    });
    expect(created).toMatchObject({ agent: { id: 'agent-1' } });
    expect(created).not.toHaveProperty('restartRequired');
    expect(restartApp).not.toHaveBeenCalled();

    await expect(registry.get('agent.delete').execute({
      agentId: 'agent-1',
      snapshot: {
        name: 'No Restart',
        pluginId: 'io.gian.fixture',
        proxy: null,
        cliPath: null,
        defaults: { model: '', thinking: '', mode: '' },
      },
    })).resolves.toBe(true);
    expect(restartApp).not.toHaveBeenCalled();

    await registry.get('agent.setPath').execute({
      agentId: 'agent-1',
      path: '/tmp/new-cli',
      previousPath: '/tmp/old-cli',
    });
    expect(restartApp).not.toHaveBeenCalled();

    await registry.get('agent.switchProxy').execute({
      agentId: 'agent-1',
      proxy: 'codex',
      cliPath: '/tmp/codex',
      previousProxy: 'claude',
      previousCliPath: '/tmp/claude',
    });
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('keeps agent.restartApp as the explicit App restart operation', async () => {
    restartApp.mockResolvedValue(true);
    await expect(registry.get('agent.restartApp').execute({})).resolves.toBe(true);
    expect(restartApp).toHaveBeenCalledTimes(1);
  });
});
