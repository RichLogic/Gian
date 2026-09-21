import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseReceipt(value, { repository, tag, revision } = {}) {
  if (value.schema !== 1 || value.repository !== repository || value.tag !== tag || value.sourceCommit !== revision
    || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || value.version !== tag.slice(1)
    || !/^[a-f0-9]{40}$/.test(revision ?? '')
    || !value.image?.startsWith(`ghcr.io/${repository.toLowerCase()}@sha256:`)
    || !/@sha256:[a-f0-9]{64}$/.test(value.image)
    || !/^[a-f0-9]{64}$/.test(value.dataSchema ?? '')) throw new Error('Invalid Remote release receipt');
  return value;
}
export function createReleaseReceipt({ repository, tag, revision, digest }) {
  const config = JSON.parse(readFileSync('release.json'));
  const provenance = JSON.parse(readFileSync('.gian-source.json'));
  if (repository !== config.repository || tag !== `v${config.version}` || provenance.workingTree) throw new Error('Release requires a committed Remote export and matching version/tag');
  const hash = createHash('sha256');
  for (const name of readdirSync('packages/remote-server/migrations').sort()) {
    hash.update(name + '\0').update(readFileSync(`packages/remote-server/migrations/${name}`)).update('\0');
  }
  return validateReleaseReceipt({ schema: 1, repository, tag, version: config.version, sourceCommit: revision, sourceDevCommit: provenance.sourceCommit, image: `ghcr.io/${repository.toLowerCase()}@${digest}`, dataSchema: hash.digest('hex') }, { repository, tag, revision });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, path] = process.argv.slice(2);
  const inputs = { repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, revision: process.env.RELEASE_SHA };
  const receipt = mode === 'create'
    ? createReleaseReceipt({ ...inputs, digest: process.env.IMAGE_DIGEST })
    : mode === 'verify' ? validateReleaseReceipt(JSON.parse(readFileSync(path)), inputs) : null;
  if (!receipt) throw new Error('Expected create or verify');
  if (mode === 'create') writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  else process.stdout.write(`${receipt.image}\n${receipt.dataSchema}\n`);
}
