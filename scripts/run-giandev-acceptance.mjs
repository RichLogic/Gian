import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog } from './test-catalog.mjs';
import { assertHeadlessTests } from './source-gate.mjs';
import { withLocalVerification } from './local-verification.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const acceptanceGroups = {
  remote: [
    'packages/remote-web/test/pairing-link.test.ts',
    'packages/remote-web/test/pairing.test.tsx',
    'packages/remote-web/test/host-selection.test.ts',
    'packages/remote-web/test/production-ops.test.ts',
    'packages/remote-web/test/settings.test.tsx',
    'packages/web/test/settings-remote.test.tsx',
    'packages/host/test/remote-settings.test.ts',
    'packages/host/test/remote-connector.test.ts',
    'packages/remote-protocol/test/negotiation.test.ts',
  ],
  'agent-defaults': [
    'packages/host/test/agent-manager.test.ts',
    'packages/host/test/agents-routes.test.ts',
    'packages/host/test/session-manager.test.ts',
    'packages/web/test/agents-view.test.tsx',
  ],
  recovery: [
    'packages/host/test/session-exact-binding.test.ts',
    'packages/host/test/runtime-resolver.test.ts',
    'packages/host/test/sidechat-fork-integration.test.ts',
    'packages/host/test/protocol-v2-client.test.ts',
  ],
  'proxy-fixtures': [
    'packages/proxies/kimi-proxy/test/rpc-deadline.test.ts',
    'packages/proxies/kimi-proxy/test/session-store.test.ts',
    'packages/proxies/kimi-proxy/test/service.test.ts',
    'packages/proxies/dsh-proxy/test/profile.test.ts',
    'packages/proxies/dsh-proxy/test/bridge-launch.test.ts',
    'packages/proxies/zcode-proxy/test/runtime-discover.test.ts',
    'scripts/proxy-real-acceptance-catalog.test.mjs',
  ],
};

export function planAcceptance(groups) {
  if (!groups.length) throw new Error('Select at least one acceptance group.');
  for (const group of groups) {
    if (!Object.hasOwn(acceptanceGroups, group)) throw new Error(`Unknown acceptance group: ${group}`);
  }
  return [...new Set(groups.flatMap(group => acceptanceGroups[group]))];
}

export function main(argv = process.argv.slice(2)) {
  const groups = [];
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group' && argv[i + 1]) groups.push(...argv[++i].split(','));
    else if (argv[i] === '--execute') execute = true;
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  const files = planAcceptance(groups);
  const plan = { groups: [...new Set(groups)], files, realProvider: false };
  console.log(JSON.stringify(plan, null, 2));
  if (!execute) return 0;
  return withLocalVerification('GianDev selected acceptance', env => {
    const { entries } = loadValidatedCatalog();
    const selected = files.map(path => {
      const entry = entries.find(candidate => candidate.path === path);
      if (!entry) throw new Error(`Unregistered acceptance file: ${path}`);
      return entry;
    });
    assertHeadlessTests(selected);
    const args = ['scripts/run-tests.mjs',
      ...[...new Set(selected.map(entry => entry.scope))].flatMap(scope => ['--scope', scope]),
      ...files.flatMap(path => ['--file', path])];
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (revision.status !== 0) throw new Error('Cannot identify acceptance revision.');
    const output = join(root, 'output', 'acceptance');
    mkdirSync(output, { recursive: true });
    const report = { ...plan, revision: revision.stdout.trim(), command: [process.execPath, ...args], status: 'RUNNING' };
    const reportPath = join(output, 'source-plan.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env: sanitizedTestEnv(env), stdio: 'inherit' });
    report.status = !result.error && result.status === 0 ? 'PASS' : 'FAIL';
    writeFileSync(reportPath, JSON.stringify({ ...report, durationMs: Date.now() - started, exitCode: result.status }, null, 2) + '\n');
    if (result.error) throw result.error;
    return result.status ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
