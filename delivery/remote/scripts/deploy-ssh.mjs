import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseReceipt } from './release-metadata.mjs';

export function deploymentTarget(env) {
  const host = env.REMOTE_SSH_HOST ?? ''; const user = env.REMOTE_SSH_USER ?? '';
  const port = env.REMOTE_SSH_PORT || '22'; const directory = env.REMOTE_DEPLOY_DIR ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user)
    || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
    || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(directory)
    || ['/', '/opt', '/srv', '/home', '/root', '/tmp'].includes(directory)) throw new Error('Configure a valid SSH host/user/port and dedicated absolute deployment directory');
  return { host, user, port, directory };
}
export function deploySsh(receiptPath, env = process.env, spawn = spawnSync) {
  const target = deploymentTarget(env);
  if (!env.REMOTE_SSH_PRIVATE_KEY || !env.REMOTE_SSH_KNOWN_HOSTS) throw new Error('SSH private key and independently verified known_hosts are required');
  const receipt = JSON.parse(readFileSync(receiptPath));
  validateReleaseReceipt(receipt, { repository: env.GITHUB_REPOSITORY, tag: receipt.tag, revision: env.RELEASE_SHA });
  const temp = mkdtempSync(join(tmpdir(), 'gian-remote-ssh-'));
  const key = join(temp, 'identity'); const known = join(temp, 'known_hosts');
  const run = (command, args, input) => {
    const childEnv = { ...env }; delete childEnv.REMOTE_SSH_PRIVATE_KEY; delete childEnv.REMOTE_SSH_KNOWN_HOSTS;
    delete childEnv.REMOTE_REGISTRY_TOKEN;
    const result = spawn(command, args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input, env: childEnv, timeout: 60 * 60 * 1000 });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status})`);
  };
  try {
    writeFileSync(key, env.REMOTE_SSH_PRIVATE_KEY + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(known, env.REMOTE_SSH_KNOWN_HOSTS + '\n', { mode: 0o600, flag: 'wx' });
    const common = ['-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
    const destination = `${target.user}@${target.host}`;
    if (env.REMOTE_SSH_MODE === 'restricted') {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(env.REMOTE_REGISTRY_USER ?? '') || !env.REMOTE_REGISTRY_TOKEN || /[\r\n]/.test(env.REMOTE_REGISTRY_TOKEN) || env.REMOTE_REGISTRY_TOKEN.length > 8192) throw new Error('Restricted deployment requires short-lived registry authentication');
      run('ssh', [...common, '-p', target.port, destination, `deploy ${receipt.sourceCommit} ${receipt.image} ${receipt.dataSchema}`], `${env.REMOTE_REGISTRY_USER}\n${env.REMOTE_REGISTRY_TOKEN}\n`);
      return;
    }
    if (env.REMOTE_SSH_MODE && env.REMOTE_SSH_MODE !== 'upload') throw new Error('Unknown SSH deployment mode');
    const releaseDir = `${target.directory}/releases/${receipt.sourceCommit}`;
    run('ssh', [...common, '-p', target.port, destination, `umask 077; mkdir -p '${releaseDir}'`]);
    run('scp', [...common, '-P', target.port, 'compose.yaml', 'scripts/deploy.sh', `${destination}:${releaseDir}/`]);
    run('ssh', [...common, '-p', target.port, destination, `bash '${releaseDir}/deploy.sh' '${target.directory}' '${receipt.sourceCommit}' '${receipt.image}' '${receipt.dataSchema}'`]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) deploySsh(process.argv[2]);
