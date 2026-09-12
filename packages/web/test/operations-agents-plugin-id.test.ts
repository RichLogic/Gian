import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    createAgent: vi.fn(),
    pickAgentHome: vi.fn(),
  };
});

import { createAgent, pickAgentHome } from '../src/api.js';
import { registry } from '../src/operations/registry.js';
import '../src/operations/agents.js';

describe('agent.create operation identity', () => {
  beforeEach(() => {
    vi.mocked(createAgent).mockReset();
    vi.mocked(pickAgentHome).mockReset();
  });

  it('forwards a standalone open pluginId and surfaces an unknown-plugin Host error', async () => {
    vi.mocked(createAgent).mockRejectedValue(new Error('unknown plugin io.gian.unknown.plugin'));
    const operation = registry.get('agent.create');
    await expect(operation.execute({
      name: 'Unknown Plugin Agent',
      pluginId: 'io.gian.unknown.plugin',
    })).rejects.toThrow(/unknown plugin io.gian.unknown.plugin/);
    expect(createAgent).toHaveBeenCalledWith({
      name: 'Unknown Plugin Agent',
      pluginId: 'io.gian.unknown.plugin',
    });
  });

  it('opens the HOME picker for drafts and saved Agents without accepting a CLI path', async () => {
    vi.mocked(pickAgentHome).mockResolvedValue('/Users/test/home');
    const operation = registry.get('agent.pickHome');
    await expect(operation.execute({})).resolves.toBe('/Users/test/home');
    expect(pickAgentHome).toHaveBeenLastCalledWith(undefined);
    await expect(operation.execute({ agentId: 'agent-1' })).resolves.toBe('/Users/test/home');
    expect(pickAgentHome).toHaveBeenLastCalledWith('agent-1');
  });
});
