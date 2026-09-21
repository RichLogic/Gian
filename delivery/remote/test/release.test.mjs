import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReleaseReceipt } from '../scripts/release-metadata.mjs';
import { deploySsh, deploymentTarget } from '../scripts/deploy-ssh.mjs';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('deployment accepts only exact stable release source and immutable owned image', () => {
  const expected = { repository: 'RichLogic/Gian-Remote', tag: 'v1.2.3', revision: 'a'.repeat(40) };
  const receipt = { schema: 1, repository: expected.repository, tag: expected.tag, version: '1.2.3', sourceCommit: expected.revision, image: `ghcr.io/richlogic/gian-remote@sha256:${'b'.repeat(64)}`, dataSchema: 'c'.repeat(64) };
  assert.equal(validateReleaseReceipt(receipt, expected), receipt);
  for (const change of [{ image: 'ghcr.io/richlogic/gian-remote:latest' }, { sourceCommit: 'd'.repeat(40) }, { image: `ghcr.io/other/remote@sha256:${'b'.repeat(64)}` }, { tag: 'v1.2.3-beta1' }, { dataSchema: '' }]) assert.throws(() => validateReleaseReceipt({ ...receipt, ...change }, expected));
});

test('SSH deployment rejects shell injection, broad paths and missing target information', () => {
  const env = { REMOTE_SSH_HOST: 'remote.example.com', REMOTE_SSH_USER: 'deploy', REMOTE_DEPLOY_DIR: '/opt/gian-remote' };
  assert.deepEqual(deploymentTarget(env), { host: 'remote.example.com', user: 'deploy', directory: '/opt/gian-remote', port: '22' });
  for (const change of [{ REMOTE_SSH_HOST: 'host;touch /tmp/x' }, { REMOTE_DEPLOY_DIR: '/opt' }, { REMOTE_DEPLOY_DIR: '/opt/../etc' }, { REMOTE_SSH_USER: '-oProxyCommand=anything' }, { REMOTE_SSH_PORT: '65536' }]) assert.throws(() => deploymentTarget({ ...env, ...change }));
});

test('restricted SSH keeps slow transfers alive with a bounded budget and cleans credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-transport-test-'));
  const receiptPath = join(directory, 'receipt.json');
  const receipt = { schema: 1, repository: 'RichLogic/Gian-Remote', tag: 'v1.2.3', version: '1.2.3', sourceCommit: 'a'.repeat(40), image: `ghcr.io/richlogic/gian-remote@sha256:${'b'.repeat(64)}`, dataSchema: 'c'.repeat(64) };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const env = { GITHUB_REPOSITORY: receipt.repository, RELEASE_SHA: receipt.sourceCommit, REMOTE_SSH_HOST: 'remote.example.com', REMOTE_SSH_USER: 'deploy', REMOTE_DEPLOY_DIR: '/srv/gian-remote', REMOTE_SSH_MODE: 'restricted', REMOTE_SSH_PRIVATE_KEY: 'fixture-key', REMOTE_SSH_KNOWN_HOSTS: 'fixture-host', REMOTE_REGISTRY_USER: 'fixture', REMOTE_REGISTRY_TOKEN: 'fixture-token' };
  try {
    for (const status of [0, 255]) {
      let key; let calls = 0;
      const invoke = () => deploySsh(receiptPath, env, (command, args, options) => {
        calls++;
        assert.equal(command, 'ssh');
        assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null']);
        for (const option of ['IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=4']) assert.ok(args.includes(option));
        assert.equal(options.timeout, 60 * 60 * 1000);
        assert.equal(options.env.REMOTE_REGISTRY_TOKEN, undefined);
        assert.equal(options.env.REMOTE_SSH_PRIVATE_KEY, undefined);
        assert.equal(options.input, 'fixture\nfixture-token\n');
        assert.equal(args.at(-1), `deploy ${receipt.sourceCommit} ${receipt.image} ${receipt.dataSchema}`);
        key = args[args.indexOf('-i') + 1];
        assert.ok(existsSync(key));
        return { status };
      });
      if (status === 0) invoke(); else assert.throws(invoke, /ssh failed/);
      assert.equal(calls, 1);
      assert.equal(existsSync(key), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('deployment retry keeps main transport but pins uploaded host files to the release', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /timeout-minutes: 65/);
  assert.match(workflow, /git restore --source "\$RELEASE_SHA" -- compose.yaml scripts\/deploy.sh/);
  assert.doesNotMatch(workflow, /git checkout --detach/);
});
