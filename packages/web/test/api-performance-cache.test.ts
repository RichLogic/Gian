import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('performance-sensitive API clients', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reuses the Agent status cache and exposes it synchronously to remounted views', async () => {
    const agents = [{ id: 'codex', name: 'Codex', ready: true }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ agents }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = await import('../src/api.js');

    expect(api.peekAgents()).toBeNull();
    expect(await api.loadAgents()).toEqual(agents);
    expect(api.peekAgents()).toEqual(agents);
    expect(await api.loadAgents()).toEqual(agents);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes paginated and rolling-upgrade event history responses', async () => {
    const event = {
      session_id: 's1', turn: 1, call_id: 'c1', event: 'user_message', ts: 1, data: { text: 'hi' },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [event], nextCursor: 4, hasMore: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([event]), { status: 200 }));
    const api = await import('../src/api.js');

    await expect(api.loadEvents('s1', 7)).resolves.toEqual({
      events: [event], nextCursor: 4, hasMore: true,
    });
    await expect(api.loadEvents('s1')).resolves.toEqual({
      events: [event], nextCursor: null, hasMore: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/s1/events?before=7');
  });

  it('rejects 500, 401, and network failures as structured history errors', async () => {
    const networkFailure = new TypeError('connection reset');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(networkFailure);
    const api = await import('../src/api.js');

    await expect(api.loadEvents('s1')).rejects.toMatchObject({
      name: 'EventHistoryLoadError', kind: 'http', status: 500,
    });
    await expect(api.loadEvents('s1')).rejects.toMatchObject({
      name: 'EventHistoryLoadError', kind: 'http', status: 401,
    });
    await expect(api.loadEvents('s1')).rejects.toMatchObject({
      name: 'EventHistoryLoadError',
      kind: 'network',
      status: null,
      originalError: networkFailure,
    });
  });

  it('forces a working-tree rescan and rejects failures instead of returning an empty list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const api = await import('../src/api.js');

    await expect(api.loadWorkingTrees({ refresh: true })).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/working_trees?refresh=1');
    await expect(api.loadWorkingTrees({ refresh: true })).rejects.toThrow(
      'working trees request failed (503)',
    );
  });
});
