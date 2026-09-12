import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ProxyManager, inspectionProfileIdentity } from '../src/proxy/manager.js';
import {
  CustomizationInventoryService,
  CustomizationRequestError,
} from '../src/proxy/customization-inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-customization-proxy.mjs');
const LEGACY_FIXTURE = join(__dirname, 'fixtures', 'fake-proxy.mjs');

const KINDS = ['skill', 'mcp', 'hook', 'rule'];

interface Harness {
  manager: ProxyManager;
  service: CustomizationInventoryService;
  spawnLog: string;
  clock: { value: number };
  dir: string;
  setReady: (ready: boolean) => void;
  setSpawnLogPath: (path: string) => void;
}

interface AgentFactsOptions {
  agentId?: string;
  cliPath?: string | null;
  proxyVersion?: string | null;
  runtimeProfileId?: string | null;
  configHome?: string | null;
  cliFingerprint?: string | null;
}

function makeHarness(options: {
  executor?: 'codex' | 'claude';
  fixture?: string;
  spawnLogPath?: string;
  fakeScope?: string;
  cacheTtlMs?: number;
  managerOptions?: Record<string, unknown>;
  facts?: AgentFactsOptions;
  resolveAgent?: (agentId: string) => Promise<unknown>;
} = {}): Harness {
  const executor = options.executor ?? 'codex';
  const dir = mkdtempSync(join(tmpdir(), 'gian-customization-'));
  const spawnLog = join(dir, 'spawns.log');
  const clock = { value: 1_000_000 };
  const state = { ready: true, spawnLogPath: options.spawnLogPath ?? spawnLog };
  const fixture = options.fixture ?? FIXTURE;
  const proxyDescriptors = {
    claude: { pluginVersion: '1.0.0', processScope: 'session' },
    codex: { pluginVersion: '1.0.0', processScope: 'shared' },
  } as const;
  const managerOptions = options.managerOptions ?? {};
  const configuredDescriptor = managerOptions[executor === 'codex' ? 'codexProxy' : 'claudeProxy'] as
    | { pluginVersion: string; processScope: 'shared' | 'session' }
    | undefined;
  const descriptorExplicitlyMissing = Object.prototype.hasOwnProperty.call(
    managerOptions,
    executor === 'codex' ? 'codexProxy' : 'claudeProxy',
  ) && configuredDescriptor === undefined;
  const resolveProxyVersion = managerOptions.resolveProxyVersion as
    | ((executor: string, version: string) => Promise<{
        entryPath: string;
        protocol?: { pluginVersion?: string; processScope?: 'shared' | 'session' };
      }>)
    | undefined;
  let defaultFacts: AgentFactsOptions = { ...options.facts };
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  const manager = new ProxyManager({
    dataDir: typeof managerOptions.dataDir === 'string'
      ? managerOptions.dataDir
      : join(dir, 'data'),
    hostVersion: '9.9.9',
    inspectionHostIdleTtlMs: typeof managerOptions.inspectionHostIdleTtlMs === 'number'
      ? managerOptions.inspectionHostIdleTtlMs
      : undefined,
    resolveInspectionLaunch: async (pluginId, facts) => {
      if (pluginId !== executor) throw new Error('unexpected inspection pluginId');
      if (descriptorExplicitlyMissing) throw new Error('no launchable descriptor');
      let entryPath = fixture;
      let descriptor = configuredDescriptor ?? proxyDescriptors[executor];
      if (facts.proxyVersion && resolveProxyVersion) {
        const exact = await resolveProxyVersion(executor, facts.proxyVersion);
        entryPath = exact.entryPath;
        descriptor = {
          pluginVersion: exact.protocol?.pluginVersion ?? facts.proxyVersion,
          processScope: exact.protocol?.processScope ?? descriptor.processScope,
        };
      }
      return {
        binding: {
          pluginId,
          pluginVersion: descriptor.pluginVersion,
          manifestSha256: 'a'.repeat(64),
          entryPath,
          processScope: descriptor.processScope,
          protocolVersion: fixture === LEGACY_FIXTURE ? '2.1' : '2.3',
          runtimeProfile: null,
        },
        acquireLease: async () => null,
        releaseUnusedLease: async () => undefined,
      };
    },
  });
  const service = new CustomizationInventoryService({
    manager,
    resolveAgent: options.resolveAgent ?? (async agentId => ({
      agentId,
      pluginId: executor,
      cliPath: defaultFacts.cliPath ?? null,
      proxyVersion: defaultFacts.proxyVersion ?? null,
      ready: state.ready,
      runtimeProfileId: defaultFacts.runtimeProfileId ?? null,
      configHome: defaultFacts.configHome ?? null,
      cliFingerprint: defaultFacts.cliFingerprint ?? null,
    })),
    workspaceLookup: workspaceId => (
      workspaceId === 'ws-1'
        ? { path: join(dir, 'workspace') }
        : workspaceId === 'ws-missing-path'
          ? { path: join(dir, 'does-not-exist', 'ws') }
          : undefined
    ),
    now: () => clock.value,
    cacheTtlMs: options.cacheTtlMs ?? 30_000,
  });
  const spawnEnv = () => ({
    GIAN_FAKE_SPAWN_LOG: state.spawnLogPath,
    GIAN_FAKE_SCOPE: options.fakeScope ?? 'shared',
  });
  // The ProxyManager config env for spawned fake proxies is controlled via
  // an env override seam: rebuild the manager with a wrapper is not required
  // here because the fixture reads GIAN_FAKE_* from the child env, which the
  // Host passes through from process.env. Tests set them before constructing.
  Object.assign(process.env, {
    GIAN_FAKE_SPAWN_LOG: state.spawnLogPath,
    GIAN_FAKE_SCOPE: options.fakeScope ?? 'shared',
  });
  void spawnEnv;
  void defaultFacts;
  return {
    manager,
    service,
    spawnLog: state.spawnLogPath,
    clock,
    dir,
    setReady: ready => { state.ready = ready; },
    setSpawnLogPath: path => { state.spawnLogPath = path; },
  };
}

function spawnCount(h: Harness): number {
  try {
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    return lines.filter(line => line.startsWith('spawn')).length;
  } catch {
    return 0;
  }
}

function violationCount(h: Harness): number {
  try {
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    return lines.filter(line => line.includes('SESSION_CREATE_VIOLATION')).length;
  } catch {
    return 0;
  }
}

function rpcListCount(h: Harness): number {
  try {
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    return lines.filter(line => line.startsWith('list ')).length;
  } catch {
    return 0;
  }
}

test.after(() => {
  for (const key of [
    'GIAN_FAKE_SPAWN_LOG',
    'GIAN_FAKE_SCOPE',
    'GIAN_FAKE_FAIL_KIND',
    'GIAN_FAKE_FAIL_MODE',
    'GIAN_FAKE_DETAIL_WRONG',
    'GIAN_FAKE_PLUGIN_VERSION',
  ]) {
    delete process.env[key];
  }
});

async function inspectAll(h: Harness, refresh = false) {
  return h.service.inspectKinds({
    agentId: 'agent-1',
    workspaceId: null,
    kinds: [...KINDS],
    refresh,
  });
}

test('aggregate inspection returns structured results for all four kinds with secrets stripped', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    await import('node:fs').then(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.ok(result, `missing ${kind}`);
      assert.equal(result.status, 'ok');
      assert.ok(result.items.length > 0, `${kind} should have fixture items`);
      assert.equal(result.truncated, false);
    }
    assert.equal(out.kinds.skill.items[0]!.id.startsWith('ci1_'), true);
    const mcp = out.kinds.mcp;
    assert.equal(mcp.completeness, 'configured');
    assert.equal(mcp.diagnostics[0]!.code, 'EFFECTIVE_STATE_UNRESOLVED');
    const serialized = JSON.stringify(out);
    for (const canary of ['sk-ant-fixture-secret123', 'canary-query', 'canary-arg']) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked`);
    }
    assert.equal(spawnCount(h), 1);
    assert.equal(violationCount(h), 0);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('cached aggregate touches neither the host nor the wire; refresh re-runs the RPCs', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    await inspectAll(h);
    assert.equal(spawnCount(h), 1);
    assert.equal(rpcListCount(h), 4);
    await inspectAll(h);
    assert.equal(rpcListCount(h), 4, 'cache hit must not re-run RPCs');
    await inspectAll(h, true);
    assert.equal(rpcListCount(h), 8, 'explicit refresh must bypass cache');
    assert.equal(spawnCount(h), 1, 'refresh reuses the live shared host');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('an explicit refresh never joins a warm-cache read single-flight and re-runs the RPCs', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'gian-refresh-marker-')), 'fail');
  writeFileSync(marker, '');
  process.env.GIAN_FAKE_FAIL_KIND = 'hook';
  process.env.GIAN_FAKE_FAIL_MARKER = marker;
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    // Warm the cache with hook failing: the read caller caches an
    // unavailable per-kind Result.
    const warm = await inspectAll(h);
    assert.equal(warm.kinds.hook.status, 'unavailable');
    assert.equal(rpcListCount(h), 4);

    // The failure clears. An explicit refresh raced against the warm-cache
    // read in the same tick must NOT join the read's no-op aggregate: it
    // issues fresh RPCs and serves the fresh Result while the read caller
    // keeps the cached one.
    rmSync(marker, { force: true });
    const [cached, refreshed] = await Promise.all([
      inspectAll(h), // warm-cache read: no RPCs expected
      inspectAll(h, true), // explicit refresh: must re-run
    ]);
    assert.equal(rpcListCount(h), 8, 'refresh joined the warm-cache read single-flight');
    assert.equal(cached.kinds.hook.status, 'unavailable', 'read caller must keep the cached Result');
    assert.equal(refreshed.kinds.hook.status, 'ok', 'refresh caller must receive the fresh Result');
    assert.equal(spawnCount(h), 1, 'refresh reuses the live shared host');
  } finally {
    delete process.env.GIAN_FAKE_FAIL_KIND;
    delete process.env.GIAN_FAKE_FAIL_MARKER;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(dirname(marker), { recursive: true, force: true });
  }
});

test('repeated kinds are deduplicated at the Service boundary and never re-issued on the wire', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await h.service.inspectKinds({
      agentId: 'agent-1',
      workspaceId: null,
      kinds: ['skill', 'skill', 'hook'],
      refresh: false,
    });
    assert.ok(out.kinds.skill);
    assert.ok(out.kinds.hook);
    assert.equal(rpcListCount(h), 2, 'a repeated kind must not issue a second wire RPC');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('cache entries expire after the TTL and refetch', async () => {
  const h = makeHarness({ fakeScope: 'shared', cacheTtlMs: 30_000 });
  try {
    await inspectAll(h);
    assert.equal(rpcListCount(h), 4);
    // TTL is driven by the injectable clock.
    h.clock.value += 30_001;
    await inspectAll(h);
    assert.equal(rpcListCount(h), 8);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('concurrent identical aggregates single-flight into one inspection host', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    await Promise.all([inspectAll(h), inspectAll(h), inspectAll(h)]);
    assert.equal(spawnCount(h), 1);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('workspace-scoped requests pass the canonical workspace path and never stray cwd', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await h.service.inspectKinds({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      kinds: ['skill'],
      refresh: false,
    });
    assert.equal(out.workspaceId, 'ws-1');
    assert.ok(out.kinds.skill.items.length > 0);
    const item = out.kinds.skill.items[0]!;
    assert.equal(item.scope.level, 'workspace');
    assert.equal(item.scope.root, realpathSync(join(h.dir, 'workspace')));
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('unknown workspace id is a 404 request error, never a probe', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const before = spawnCount(h);
    await assert.rejects(
      h.service.inspectKinds({ agentId: 'agent-1', workspaceId: 'nope', kinds: ['skill'], refresh: false }),
      error => error instanceof CustomizationRequestError && error.status === 404,
    );
    assert.equal(spawnCount(h), before, 'no host may spawn for a 404 workspace');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('an Agent that is not ready yields structurally complete unavailable results without spawning', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    h.setReady(false);
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      assert.equal(out.kinds[kind].status, 'unavailable');
      assert.equal(out.kinds[kind].completeness, 'none');
      assert.deepEqual(out.kinds[kind].items, []);
      assert.equal(out.kinds[kind].diagnostics[0]!.code, 'PROVIDER_INSPECTION_FAILED');
    }
    assert.equal(spawnCount(h), 0);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('legacy proxies without customization.list produce proxy_unsupported with PROXY_UPGRADE_REQUIRED', async () => {
  const h = makeHarness({
    executor: 'claude',
    fixture: LEGACY_FIXTURE,
    fakeScope: 'session',
    managerOptions: {
      claudeProxy: { pluginVersion: '0.2.0', processScope: 'session' },
    },
  });
  try {
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.equal(result.status, 'proxy_unsupported');
      assert.equal(result.completeness, 'none');
      assert.deepEqual(result.items, []);
      assert.equal(result.diagnostics[0]!.code, 'PROXY_UPGRADE_REQUIRED');
    }
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a failing kind is isolated: other kinds stay ok and the host survives', async () => {
  process.env.GIAN_FAKE_FAIL_KIND = 'hook';
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await inspectAll(h);
    assert.equal(out.kinds.hook.status, 'unavailable');
    assert.equal(out.kinds.hook.completeness, 'none');
    assert.equal(out.kinds.hook.diagnostics[0]!.code, 'PROVIDER_INSPECTION_FAILED');
    assert.equal(out.kinds.skill.status, 'ok');
    assert.equal(out.kinds.mcp.status, 'ok');
    assert.equal(out.kinds.rule.status, 'ok');
    // A different host (no fail kind) still works — the shared host was not
    // torn down by the failing kind.
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
    delete process.env.GIAN_FAKE_FAIL_KIND;
    const healthy = makeHarness({ fakeScope: 'shared' });
    try {
      const again = await inspectAll(healthy, true);
      assert.equal(again.kinds.hook.status, 'ok');
    } finally {
      await healthy.manager.closeAll();
      rmSync(healthy.dir, { recursive: true, force: true });
    }
  } finally {
    delete process.env.GIAN_FAKE_FAIL_KIND;
  }
});

test('an invalid proxy result for one kind maps to unavailable without killing other kinds', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    process.env.GIAN_FAKE_FAIL_KIND = 'mcp';
    process.env.GIAN_FAKE_FAIL_MODE = 'invalid-result';
    const out = await inspectAll(h);
    // The client validator rejects the malformed result → unavailable.
    assert.equal(out.kinds.mcp.status, 'unavailable');
    assert.equal(out.kinds.skill.status, 'ok');
    process.env.GIAN_FAKE_FAIL_MODE = 'error';
  } finally {
    delete process.env.GIAN_FAKE_FAIL_KIND;
    delete process.env.GIAN_FAKE_FAIL_MODE;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('detail serves only known stable ids and redacts canaries; unknown ids are 404', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await inspectAll(h);
    const skillId = out.kinds.skill.items[0]!.id;
    const detail = await h.service.inspectDetail({
      agentId: 'agent-1',
      workspaceId: null,
      kind: 'skill',
      itemId: skillId,
      refresh: false,
    });
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('sk-ant-fixture-secret123'), false);

    const mcpId = out.kinds.mcp.items[0]!.id;
    const mcpDetail = await h.service.inspectDetail({
      agentId: 'agent-1',
      workspaceId: null,
      kind: 'mcp',
      itemId: mcpId,
      refresh: false,
    });
    assert.equal(mcpDetail.text.includes('ghp_fixture_secret'), false);
    assert.equal(mcpDetail.text.includes('canary-arg'), false);

    await assert.rejects(
      h.service.inspectDetail({
        agentId: 'agent-1',
        workspaceId: null,
        kind: 'skill',
        itemId: 'ci1_' + 'f'.repeat(32),
        refresh: false,
      }),
      error => error instanceof CustomizationRequestError && error.status === 404,
    );
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('transient session-scoped inspection hosts (claude) shut down, exit their process, and never create sessions', async () => {
  const h = makeHarness({ executor: 'claude', fakeScope: 'session' });
  try {
    const out = await inspectAll(h);
    assert.equal(out.kinds.skill.status, 'ok');
    assert.equal(violationCount(h), 0);
    assert.equal(spawnCount(h), 1);
    // The transient host must actually EXIT after release() — poll the OS
    // process table instead of sleeping.
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    const pid = Number(lines.find(line => line.startsWith('spawn '))!.split(' ')[1]);
    assert.ok(Number.isFinite(pid) && pid > 0, `expected a spawned pid, got ${pid}`);
    let exited = false;
    for (let i = 0; i < 100; i += 1) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        exited = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(exited, true, `transient inspection host pid ${pid} never exited after release`);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a missing Agent is a 404 request condition, and a missing registered Workspace path is a 409', async () => {
  const h = makeHarness({
    resolveAgent: async agentId => {
      if (agentId === 'nope') throw new Error(`agent not found: ${agentId}`);
      return {
        agentId,
        pluginId: 'codex',
        cliPath: null,
        proxyVersion: null,
        ready: true,
        runtimeProfileId: null,
        configHome: null,
        cliFingerprint: null,
      };
    },
  });
  try {
    await assert.rejects(
      h.service.inspectKinds({ agentId: 'nope', workspaceId: null, kinds: ['skill'], refresh: false }),
      error => error instanceof CustomizationRequestError && error.status === 404,
    );
    await assert.rejects(
      h.service.inspectKinds({ agentId: 'agent-1', workspaceId: 'ws-missing-path', kinds: ['skill'], refresh: false }),
      error => error instanceof CustomizationRequestError && error.status === 409,
    );
    assert.equal(spawnCount(h), 0, '404/409 conditions must never spawn an inspection host');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('non-ready Agents produce a per-kind unavailable result (kind matches every slot)', async () => {
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    h.setReady(false);
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.equal(result.status, 'unavailable');
      // The Result's kind field must describe ITS OWN slot, never a recycled
      // kinds[0] result.
      assert.equal(result.kind, kind);
    }
    assert.equal(spawnCount(h), 0);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('same CLI with different runtime profiles never shares cache entries or inspection hosts', async () => {
  const h = makeHarness({
    fakeScope: 'shared',
    facts: { cliPath: '/usr/local/bin/codex' },
  });
  try {
    // Profile A resolves the plain harness facts.
    await inspectAll(h);
    assert.equal(rpcListCount(h), 4);

    // Profile B: identical executor/cliPath/proxyVersion but a different
    // authoritative runtimeProfile identity and configHome.
    const hB = makeHarness({
      fakeScope: 'shared',
      facts: { cliPath: '/usr/local/bin/codex', runtimeProfileId: 'profile-B', configHome: '/Users/b/.codex-b' },
    });
    try {
      await inspectAll(hB);
      // The second profile must re-run every RPC (no cache crossing)…
      assert.equal(rpcListCount(hB), 4);
      // …and must get its own shared host process (no host crossing).
      assert.equal(spawnCount(hB), 1);

      // Profile change on the SAME cliPath must not reuse profile A's cache.
      const hB2 = makeHarness({
        fakeScope: 'shared',
        facts: { cliPath: '/usr/local/bin/codex', runtimeProfileId: 'profile-B2' },
      });
      try {
        await inspectAll(hB2);
        assert.equal(rpcListCount(hB2), 4, 'changed profile reuses profile A cache');
        assert.equal(spawnCount(hB2), 1);
      } finally {
        await hB2.manager.closeAll();
        rmSync(hB2.dir, { recursive: true, force: true });
      }
    } finally {
      await hB.manager.closeAll();
      rmSync(hB.dir, { recursive: true, force: true });
    }
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('one manager reuses the exact-same-profile inspection host and isolates different profiles', async () => {
  const h = makeHarness({
    fakeScope: 'shared',
    resolveAgent: async agentId => ({
      agentId,
      pluginId: 'codex',
      cliPath: '/usr/local/bin/codex',
      proxyVersion: '1.0.0',
      ready: true,
      runtimeProfileId: agentId === 'agent-a' ? 'profile-A' : 'profile-B',
      configHome: agentId === 'agent-a' ? '/Users/a/.codex-a' : '/Users/b/.codex-b',
      cliFingerprint: agentId === 'agent-a' ? 'fp-a' : 'fp-b',
    }),
  });
  try {
    // Profile A: first inspection spawns its dedicated host.
    await h.service.inspectKinds({ agentId: 'agent-a', workspaceId: null, kinds: [...KINDS], refresh: false });
    assert.equal(spawnCount(h), 1);
    // Same profile, same manager, soon after: the dedicated host is reused —
    // an explicit refresh must not respawn a second Proxy/lease.
    await h.service.inspectKinds({ agentId: 'agent-a', workspaceId: null, kinds: [...KINDS], refresh: true });
    assert.equal(spawnCount(h), 1, 'exact-same-profile inspection must reuse the dedicated host');
    const rpcsAfterA = rpcListCount(h);
    assert.equal(rpcsAfterA, 8);

    // Profile B under the SAME manager: a different identity gets its own
    // host and its own cache entries (never profile A's results).
    await h.service.inspectKinds({ agentId: 'agent-b', workspaceId: null, kinds: [...KINDS], refresh: false });
    assert.equal(spawnCount(h), 2, 'different profile must spawn its own inspection host');
    assert.equal(rpcListCount(h), rpcsAfterA + 4, 'different profile must not reuse profile A cache entries');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('dedicated inspection hosts are idle-released: process and lease do not accumulate', async () => {
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: { inspectionHostIdleTtlMs: 150 },
    facts: { cliPath: '/usr/local/bin/codex', runtimeProfileId: 'profile-X', configHome: '/Users/x/.codex-x', cliFingerprint: 'fp-x' },
  });
  try {
    await inspectAll(h);
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    const pid = Number(lines.find(line => line.startsWith('spawn '))!.split(' ')[1]);
    assert.ok(Number.isFinite(pid) && pid > 0);

    // The dedicated inspection host is borrow-counted: while a second
    // inspection runs within the idle window it is REUSED (no respawn)…
    await inspectAll(h, true);
    assert.equal(spawnCount(h), 1, 'same-profile inspection within the idle window must reuse the host');

    // …and after the idle TTL without a borrow it shuts down for real:
    // process absence is the only proof the lease can be released.
    let exited = false;
    for (let i = 0; i < 200; i += 1) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) { exited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(exited, true, `dedicated inspection host pid ${pid} never exited after the idle window`);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a resolver that cannot resolve the pinned Proxy version is proxy_unsupported + PROXY_UPGRADE_REQUIRED, never a generic unavailable', async () => {
  process.env.GIAN_FAKE_PLUGIN_VERSION = '0.98.0';
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: {
      codexProxy: { pluginVersion: '0.98.0', processScope: 'shared' },
      resolveProxyVersion: async () => {
        throw new Error('the pinned artifact was removed from the release channel');
      },
    },
    facts: { proxyVersion: '0.7.0' },
  });
  try {
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.equal(result.status, 'proxy_unsupported');
      assert.equal(result.completeness, 'none');
      assert.deepEqual(result.items, []);
      assert.equal(result.diagnostics[0]!.code, 'PROXY_UPGRADE_REQUIRED');
    }
    assert.equal(spawnCount(h), 0, 'no host may spawn for an unresolvable pinned artifact');
  } finally {
    delete process.env.GIAN_FAKE_PLUGIN_VERSION;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a pinned version with no launchable descriptor at all is proxy_unsupported + PROXY_UPGRADE_REQUIRED', async () => {
  const h = makeHarness({
    executor: 'claude',
    fakeScope: 'session',
    managerOptions: { claudeProxy: undefined },
    facts: { proxyVersion: '9.9.9' },
  });
  try {
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.equal(result.status, 'proxy_unsupported');
      assert.equal(result.diagnostics[0]!.code, 'PROXY_UPGRADE_REQUIRED');
    }
    assert.equal(spawnCount(h), 0);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a pinned Proxy version the manager cannot launch (non-codex) is an honest proxy_unsupported + PROXY_UPGRADE_REQUIRED', async () => {
  const h = makeHarness({
    executor: 'claude',
    fakeScope: 'session',
    facts: { proxyVersion: '9.9.9' },
  });
  try {
    const out = await inspectAll(h);
    for (const kind of KINDS) {
      const result = out.kinds[kind];
      assert.equal(result.status, 'proxy_unsupported');
      assert.equal(result.completeness, 'none');
      assert.deepEqual(result.items, []);
      assert.equal(result.diagnostics[0]!.code, 'PROXY_UPGRADE_REQUIRED');
    }
    // No inspection host may be spawned for a mismatched artifact.
    assert.equal(spawnCount(h), 0);
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('codex inspection routes to the EXACT pinned Proxy artifact version', async () => {
  const oldFixtureDir = mkdtempSync(join(tmpdir(), 'gian-old-proxy-'));
  const oldEntry = join(oldFixtureDir, 'old-proxy.mjs');
  mkdirSync(oldFixtureDir, { recursive: true });
  // A second copy of the fixture stands in for the old pinned artifact.
  copyFileSync(FIXTURE, oldEntry);
  process.env.GIAN_FAKE_PLUGIN_VERSION = '0.99.0';
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: {
      codexProxy: { pluginVersion: '0.99.0', processScope: 'shared' },
      resolveProxyVersion: async (executor: string, version: string) => {
        if (executor !== 'codex') throw new Error('unexpected executor');
        if (version === '0.99.0') {
          return { entryPath: oldEntry, protocol: { pluginVersion: '0.99.0', processScope: 'shared' } };
        }
        throw new Error(`unexpected version ${version}`);
      },
    },
    facts: { proxyVersion: '0.99.0' },
  });
  try {
    const out = await inspectAll(h);
    assert.equal(out.kinds.skill.status, 'ok');
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    const entries = lines.filter(line => line.startsWith('entry ')).map(line => line.slice('entry '.length));
    assert.equal(entries.length, 1);
    assert.equal(entries[0], oldEntry, 'inspection host must launch the EXACT pinned artifact, not the current one');
  } finally {
    delete process.env.GIAN_FAKE_PLUGIN_VERSION;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(oldFixtureDir, { recursive: true, force: true });
  }
});

test('detail responses are re-validated against the requested kind/id (wrong-kind responses are 404)', async () => {
  process.env.GIAN_FAKE_DETAIL_WRONG = '1';
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await inspectAll(h);
    const skillId = out.kinds.skill.items[0]!.id;
    await assert.rejects(
      h.service.inspectDetail({
        agentId: 'agent-1',
        workspaceId: null,
        kind: 'skill',
        itemId: skillId,
        refresh: false,
      }),
      error => error instanceof CustomizationRequestError && error.status === 404,
    );
  } finally {
    delete process.env.GIAN_FAKE_DETAIL_WRONG;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('same-host failure isolation: a failing kind never kills the shared host and a refresh recovers', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'gian-fail-marker-')), 'fail');
  writeFileSync(marker, '');
  process.env.GIAN_FAKE_FAIL_KIND = 'hook';
  process.env.GIAN_FAKE_FAIL_MARKER = marker;
  const h = makeHarness({ fakeScope: 'shared' });
  try {
    const out = await inspectAll(h);
    assert.equal(out.kinds.hook.status, 'unavailable');
    assert.equal(out.kinds.skill.status, 'ok');
    const lines = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    const pids = lines.filter(line => line.startsWith('spawn ')).map(line => line.split(' ')[1]);
    assert.equal(pids.length, 1);

    // The failure clears (transient): removing the marker recovers the kind
    // on THE SAME harness/host without spawning a replacement host.
    rmSync(marker, { force: true });
    const again = await inspectAll(h, true);
    assert.equal(again.kinds.hook.status, 'ok');
    const after = readFileSync(h.spawnLog, 'utf8').split('\n').filter(Boolean);
    const pidsAfter = after.filter(line => line.startsWith('spawn ')).map(line => line.split(' ')[1]);
    assert.deepEqual(pidsAfter, pids, 'failing kind must never recycle the shared host');
  } finally {
    delete process.env.GIAN_FAKE_FAIL_KIND;
    delete process.env.GIAN_FAKE_FAIL_MARKER;
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('transient Claude detail self-heals on a new inspection host after Host restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-claude-restart-'));
  const firstLog = join(dir, 'spawns.log');
  const secondLog = join(dir, 'spawns2.log');
  const makeClaudeHarness = (log: string) => makeHarness({
    executor: 'claude',
    fakeScope: 'session',
    spawnLogPath: log,
    managerOptions: { dataDir: join(dir, 'data') },
  });
  let first: Harness | null = null;
  try {
    first = makeClaudeHarness(firstLog);
    const out = await inspectAll(first);
    const skillId = out.kinds.skill.items[0]!.id;
    await first.manager.closeAll();
    first = null;

    // Host restarted: a brand-new manager/service/proxy process. Its scanner
    // memory is empty — the detail must rebuild the list map and serve.
    const second = makeClaudeHarness(secondLog);
    try {
      const detail = await second.service.inspectDetail({
        agentId: 'agent-1',
        workspaceId: null,
        kind: 'skill',
        itemId: skillId,
        refresh: false,
      });
      assert.equal(detail.status, 'ok');
      assert.ok(detail.text.includes('Fixture entry'));
      // The fresh transient host for the detail has empty scanner memory: it
      // self-heals by re-listing. Transient hosts are per-inspection, so the
      // list + detail each ran on their own process (2 total, both fresh).
      assert.equal(spawnCount(second), 2, 'self-heal rebuilds the item map on the new host');
    } finally {
      await second.manager.closeAll();
      rmSync(second.dir, { recursive: true, force: true });
    }
  } finally {
    if (first) await first.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closeByExecutor cancels idle timers and drops borrow bookkeeping: no late cleanup on the closed manager', async () => {
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: { inspectionHostIdleTtlMs: 300 },
    facts: {
      cliPath: '/usr/local/bin/codex',
      runtimeProfileId: 'profile-idle-close',
      configHome: '/Users/x/.codex',
      cliFingerprint: 'fp-x',
    },
  });
  interface BorrowMapSurface {
    size: number;
    clear(): void;
    get(host: object): { count: number; idleTimer?: NodeJS.Timeout } | undefined;
  }
  type ManagerSurface = {
    inspectionBorrowsByExecutor: Map<string, BorrowMapSurface>;
  };
  try {
    await inspectAll(h);
    // The dedicated host is borrowed once and released: the idle timer is
    // pending and its borrow record is registered.
    const manager = h.manager as unknown as ManagerSurface;
    const recorder = manager.inspectionBorrowsByExecutor.get('codex');
    const hosts = recorder ? [...(recorder as unknown as Map<object, unknown>).keys()] : [];
    assert.equal(hosts.length, 1);
    assert.equal(recorder?.get(hosts[0]!)?.count, 0, 'the released host must carry a pending idle record');

    // A close must cancel the timer and drop the record BEFORE the TTL can
    // fire: no 300ms-later timer callback may operate on the closed manager.
    await h.manager.closeByExecutor('codex');
    assert.equal(recorder?.size ?? 0, 0, 'closeByExecutor must clear every borrow record of the executor');
    assert.equal(
      manager.inspectionBorrowsByExecutor.get('codex')?.size ?? 0,
      0,
      'no borrow records may survive a close',
    );

    // Wait past the original TTL: a stale timer would have fired here. The
    // manager must stay clean, and a fresh inspection must spawn and serve
    // on a NEW host generation.
    await new Promise(resolve => setTimeout(resolve, 700));
    const again = await inspectAll(h, true);
    assert.equal(again.kinds.skill.status, 'ok', 'a post-close inspection must still work');
    assert.equal(spawnCount(h), 2, 'the post-close inspection must spawn a fresh host');
    const freshRecorder = manager.inspectionBorrowsByExecutor.get('codex');
    const freshHosts = freshRecorder
      ? [...(freshRecorder as unknown as Map<object, unknown>).keys()]
      : [];
    assert.equal(freshHosts.length, 1);
    assert.notEqual(freshHosts[0], hosts[0], 'a fresh host must replace the closed one');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a borrower released after close does not resurrect an idle timer for the closed host generation', async () => {
  const facts = {
    cliPath: '/usr/local/bin/codex',
    proxyVersion: '1.0.0',
    runtimeProfileId: 'profile-active-close',
    configHome: '/Users/x/.codex',
    cliFingerprint: 'fp-x',
  };
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: { inspectionHostIdleTtlMs: 100 },
    facts,
  });
  type BorrowRecord = { count: number; idleTimer?: NodeJS.Timeout };
  type ManagerSurface = {
    inspectionBorrowsByExecutor: Map<string, Map<object, BorrowRecord>>;
  };
  try {
    const handle = await h.manager.acquireInspectionHost('codex', facts);
    const manager = h.manager as unknown as ManagerSurface;
    const record = manager.inspectionBorrowsByExecutor.get('codex')?.get(handle.host);
    assert.equal(record?.count, 1);

    await h.manager.closeByExecutor('codex');
    await handle.release();

    assert.equal(
      manager.inspectionBorrowsByExecutor.has('codex'),
      false,
      'a late borrower release must not recreate executor bookkeeping',
    );
    assert.equal(record?.idleTimer, undefined, 'a late borrower release must not schedule an idle timer');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(spawnCount(h), 1, 'no late timer may create or operate on another host generation');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('an acquire racing the same-identity idle retirement never borrows the retiring host; the fresh generation serves', async () => {
  const h = makeHarness({
    fakeScope: 'shared',
    managerOptions: { inspectionHostIdleTtlMs: 120 },
    facts: {
      cliPath: '/usr/local/bin/codex',
      runtimeProfileId: 'profile-idle-race',
      configHome: '/Users/x/.codex',
      cliFingerprint: 'fp-x',
    },
  });
  type ManagerSurface = {
    inspectionBorrowsByExecutor: Map<string, Map<object, unknown>>;
  };
  try {
    await inspectAll(h);
    const manager = h.manager as unknown as ManagerSurface;
    const firstHost = [...(manager.inspectionBorrowsByExecutor.get('codex')?.keys() ?? [])][0];
    assert.ok(firstHost);

    // Wait just past the idle TTL so the retire has started (the host is
    // removed from its map synchronously and shutting down), then acquire
    // again for the SAME identity: the acquire must not be handed the
    // retiring host — it re-validates currency and gets the fresh
    // generation, and every inspection RPC must succeed on the live host.
    await new Promise(resolve => setTimeout(resolve, 180));
    const out = await inspectAll(h, true);
    assert.equal(out.kinds.skill.status, 'ok', 'the racing acquire must land on a live host');
    const currentHosts = [
      ...(manager.inspectionBorrowsByExecutor.get('codex')?.keys() ?? []),
    ];
    assert.equal(currentHosts.length, 1);
    assert.notEqual(currentHosts[0], firstHost, 'a retiring host must never be lent out again');
    assert.equal(spawnCount(h), 2, 'the racing acquire must use the fresh host generation');
  } finally {
    await h.manager.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('inspectionProfileIdentity is a full 128-bit digest, never a 64-bit truncation', async () => {
  // Legacy facts (all null or absent) yield null: the plain (cliPath,
  // proxyVersion) session-host identity applies.
  assert.equal(inspectionProfileIdentity({}), null);
  assert.equal(inspectionProfileIdentity({ cliPath: '/usr/local/bin/codex' }), null);
  // Profile facts produce a 128-bit (32-hex) SHA-256 prefix — the same width
  // as the wire's stable customization item ids.
  const wide = inspectionProfileIdentity({ runtimeProfileId: 'p', configHome: '/c', cliFingerprint: 'f' });
  assert.ok(wide !== null && /^[a-f0-9]{32}$/.test(wide),
    `expected a 32-hex (128-bit) identity, got ${wide}`);
  // Distinct profiles must not collapse into the same identity.
  const a = inspectionProfileIdentity({ runtimeProfileId: 'profile-a', configHome: '/a', cliFingerprint: 'fa' });
  const b = inspectionProfileIdentity({ runtimeProfileId: 'profile-b', configHome: '/b', cliFingerprint: 'fb' });
  assert.notEqual(a, b, 'distinct profile facts must produce distinct identities');
  // The identity is deterministic for identical facts.
  assert.equal(
    inspectionProfileIdentity({ runtimeProfileId: 'p', configHome: '/c', cliFingerprint: 'f' }),
    wide,
    'identical profile facts must produce the same identity',
  );
});
