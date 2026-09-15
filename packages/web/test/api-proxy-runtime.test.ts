import { describe, expect, it } from 'vitest';
import {
  discoverProxyRuntime,
  installManagedRuntime,
  loadManagedRuntimeStatus,
  pickAgentHome,
  probeProxyRuntime,
} from '../src/api.js';
import { mockFetch } from './setup.js';

// WP6 Runtime REST boundary (issue #150): typed, URL-encoded calls with
// stable Host error propagation. Web never invents or reshapes actions.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISCOVER_BODY = {
  pluginId: 'io.acme.external',
  pluginVersion: '1.0.0',
  runtime: { kind: 'external', id: 'acme-cli', displayName: 'Acme CLI', verifiedVersions: ['1.0.0'] },
  candidates: [{ path: '/usr/local/bin/acme', source: 'path' }],
  setupActions: [{ id: 'download', kind: 'open_url', label: 'Download', url: 'https://acme.example/' }],
  availableActions: ['select_runtime', 'create_agent'],
};

const PROBE_BODY = {
  pluginId: 'io.acme.external',
  pluginVersion: '1.0.0',
  selectedPath: '/usr/local/bin/acme',
  profile: {
    id: 'rp-1',
    agentId: 'draft',
    pluginId: 'io.acme.external',
    runtimeId: 'acme-cli',
    path: '/usr/local/bin/acme',
    version: '1.0.0',
    configHome: null,
    contentFingerprint: null,
    verifiedVersions: ['1.0.0'],
    verification: 'verified',
  },
  availableActions: ['create_agent'],
};

describe('Proxy Runtime API (discover/probe)', () => {
  it('discover POSTs to the encoded runtime endpoint and returns the typed body', async () => {
    let seenUrl = '';
    let seenMethod = '';
    mockFetch(async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? 'GET';
      return json(DISCOVER_BODY);
    });

    const result = await discoverProxyRuntime('io.acme.external');
    expect(seenUrl).toBe('/api/proxies/io.acme.external/runtime/discover');
    expect(seenMethod).toBe('POST');
    expect(result.runtime.displayName).toBe('Acme CLI');
    expect(result.candidates[0]?.path).toBe('/usr/local/bin/acme');
    expect(result.availableActions).toEqual(['select_runtime', 'create_agent']);
  });

  it('discover URL-encodes the pluginId path segment', async () => {
    let seenUrl = '';
    mockFetch(async input => {
      seenUrl = String(input);
      return json(DISCOVER_BODY);
    });

    await discoverProxyRuntime('io.acme.external/rc 1');
    expect(seenUrl).toBe('/api/proxies/io.acme.external%2Frc%201/runtime/discover');
  });

  it('probe POSTs only the raw path and returns the probe projection', async () => {
    let seenUrl = '';
    let seenBody = '';
    mockFetch(async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? '');
      return json(PROBE_BODY);
    });

    const result = await probeProxyRuntime('io.acme.external', '/opt/acme/bin/acme');
    expect(seenUrl).toBe('/api/proxies/io.acme.external/runtime/probe');
    expect(JSON.parse(seenBody)).toEqual({ path: '/opt/acme/bin/acme' });
    expect(result.selectedPath).toBe('/usr/local/bin/acme');
    expect(result.profile.verification).toBe('verified');
  });

  it('propagates the Host error message with its status, not a generic failure', async () => {
    mockFetch(async () => json({ error: 'discover/probe require a compatible installed package.' }, 409));
    await expect(discoverProxyRuntime('io.acme.external'))
      .rejects.toThrow('discover/probe require a compatible installed package.');

    mockFetch(async () => json({ error: 'path must be a canonical absolute path.' }, 400));
    await expect(probeProxyRuntime('io.acme.external', 'relative/path'))
      .rejects.toThrow('path must be a canonical absolute path.');
  });

  it('falls back to a status-coded error when the body carries no message', async () => {
    mockFetch(async () => json({}, 502));
    await expect(discoverProxyRuntime('io.acme.external')).rejects.toThrow('(502)');
  });

  it('reads the active managed generation from an encoded Proxy endpoint', async () => {
    let seenUrl = '';
    mockFetch(async input => {
      seenUrl = String(input);
      return json({ pluginId: 'io.acme/runtime', active: null, staged: [] });
    });
    const status = await loadManagedRuntimeStatus('io.acme/runtime');
    expect(seenUrl).toBe('/api/proxies/io.acme%2Fruntime/runtime');
    expect(status.active).toBeNull();
  });

  it('streams bounded Host install progress before returning the managed generation', async () => {
    let seenAccept = '';
    const generation = { generationId: 'generation-1', pluginId: 'io.acme.external' };
    const source = [
      JSON.stringify({ type: 'progress', progress: { stage: 'catalog', status: 'started' } }),
      JSON.stringify({ type: 'progress', progress: { stage: 'runtime-plan', status: 'started' } }),
      JSON.stringify({
        type: 'progress',
        progress: {
          stage: 'runtime-download', status: 'progress', componentId: 'acme-cli', version: '1.0.0',
          receivedBytes: 50, totalBytes: 100,
        },
      }),
      JSON.stringify({ type: 'result', generation }),
      '',
    ].join('\n');
    mockFetch(async (_input, init) => {
      seenAccept = new Headers(init?.headers).get('accept') ?? '';
      const bytes = new TextEncoder().encode(source);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
    });
    const progress: Array<{ stage: string; status: string }> = [];

    const result = await installManagedRuntime('io.acme.external', undefined, event => {
      progress.push({ stage: event.stage, status: event.status });
    });

    expect(seenAccept).toBe('application/x-ndjson');
    expect(result.generationId).toBe('generation-1');
    expect(progress).toEqual([
      { stage: 'catalog', status: 'started' },
      { stage: 'runtime-plan', status: 'started' },
      { stage: 'runtime-download', status: 'progress' },
    ]);
  });

  it('fails a streamed install with the Host error instead of accepting a partial result', async () => {
    mockFetch(async () => new Response(
      `${JSON.stringify({ type: 'error', error: { code: 'RUNTIME_DIGEST_MISMATCH', message: 'digest mismatch' } })}\n`,
      { headers: { 'content-type': 'application/x-ndjson' } },
    ));

    await expect(installManagedRuntime('io.acme.external', undefined, () => undefined))
      .rejects.toThrow('digest mismatch');
  });

  it('opens the draft or saved-Agent HOME picker without sending a path', async () => {
    const calls: Array<[string, string]> = [];
    mockFetch(async (input, init) => {
      calls.push([String(input), init?.method ?? 'GET']);
      return json({ path: '/Users/test/home' });
    });
    await expect(pickAgentHome()).resolves.toBe('/Users/test/home');
    await expect(pickAgentHome('agent/1')).resolves.toBe('/Users/test/home');
    expect(calls).toEqual([
      ['/api/agents/pick-home', 'POST'],
      ['/api/agents/agent%2F1/pick-home', 'POST'],
    ]);
  });
});
