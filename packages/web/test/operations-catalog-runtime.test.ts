import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    discoverProxyRuntime: vi.fn(),
    probeProxyRuntime: vi.fn(),
  };
});

import { discoverProxyRuntime, probeProxyRuntime } from '../src/api.js';
import { registry } from '../src/operations/registry.js';
import { OPERATION_POLICIES } from '../src/operations/types.js';
import { catalogEntityKey, runtimeEntityKey } from '../src/operations/catalog.js';
import '../src/operations/catalog.js';

// WP6 Runtime operations (issue #150): registered pending operations with
// per-pluginId entity keys, wired to the typed api.ts calls.

describe('catalog runtime operations', () => {
  beforeEach(() => {
    vi.mocked(discoverProxyRuntime).mockReset();
    vi.mocked(probeProxyRuntime).mockReset();
  });

  it('registers discover/probe as pending operations', () => {
    expect(OPERATION_POLICIES['catalog.discoverRuntime']).toBe('pending');
    expect(OPERATION_POLICIES['catalog.probeRuntime']).toBe('pending');
    expect(registry.get('catalog.discoverRuntime')).toBeTruthy();
    expect(registry.get('catalog.probeRuntime')).toBeTruthy();
  });

  it('isolates runtime state per pluginId, separate from install operations', () => {
    expect(runtimeEntityKey('io.acme.a')).toBe('catalog:io.acme.a:runtime');
    expect(runtimeEntityKey('io.acme.b')).toBe('catalog:io.acme.b:runtime');
    expect(runtimeEntityKey('io.acme.a')).not.toBe(runtimeEntityKey('io.acme.b'));
    expect(runtimeEntityKey('io.acme.a')).not.toBe(catalogEntityKey('io.acme.a'));
    expect(registry.get('catalog.discoverRuntime').entityKey({ pluginId: 'io.acme.a' }))
      .toBe('catalog:io.acme.a:runtime');
    expect(registry.get('catalog.probeRuntime').entityKey({ pluginId: 'io.acme.a', path: '/x' }))
      .toBe('catalog:io.acme.a:runtime');
  });

  it('executes through the typed api functions', async () => {
    vi.mocked(discoverProxyRuntime).mockResolvedValue({ pluginId: 'io.acme.a' } as never);
    await registry.get('catalog.discoverRuntime').execute({ pluginId: 'io.acme.a' });
    expect(discoverProxyRuntime).toHaveBeenCalledWith('io.acme.a');

    vi.mocked(probeProxyRuntime).mockResolvedValue({ selectedPath: '/bin/x' } as never);
    await registry.get('catalog.probeRuntime').execute({ pluginId: 'io.acme.a', path: '/bin/x' });
    expect(probeProxyRuntime).toHaveBeenCalledWith('io.acme.a', '/bin/x');
  });
});
