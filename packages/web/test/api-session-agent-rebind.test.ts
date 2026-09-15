import { afterEach, describe, expect, it, vi } from 'vitest';
import { rebindDeletedSessionAgent } from '../src/api.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

describe('deleted Session Agent API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the replacement Agent id to the scoped Session endpoint', async () => {
    const session = sessionContractFixture({ agent_id: 'agent-current' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ session }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(rebindDeletedSessionAgent('session/old', 'agent-current')).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2Fold/rebind-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-current' }),
    });
  });

  it('surfaces the Host rejection message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'Choose an Agent that uses the same Proxy (codex).' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));

    await expect(rebindDeletedSessionAgent('session-1', 'agent-claude'))
      .rejects.toThrow('Choose an Agent that uses the same Proxy (codex).');
  });
});
