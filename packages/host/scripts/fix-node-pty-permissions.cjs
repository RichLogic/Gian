#!/usr/bin/env node
// pnpm can strip the executable bit from node-pty's prebuilt spawn-helper.
// Gian's Workbench Terminal is the sole PTY owner, so repair the helper from
// the host package that actually depends on node-pty.

const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

function findNodePtyRoots(start) {
  const found = new Set();
  let directory = resolve(start);
  while (true) {
    const direct = join(directory, 'node_modules', 'node-pty');
    if (existsSync(direct)) found.add(direct);

    const pnpmStore = join(directory, 'node_modules', '.pnpm');
    if (existsSync(pnpmStore)) {
      for (const entry of readdirSync(pnpmStore)) {
        if (!entry.startsWith('node-pty@')) continue;
        const nested = join(pnpmStore, entry, 'node_modules', 'node-pty');
        if (existsSync(nested)) found.add(nested);
      }
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return Array.from(found);
}

const platformDirectories = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
];

for (const root of findNodePtyRoots(__dirname)) {
  for (const platform of platformDirectories) {
    const helper = join(root, 'prebuilds', platform, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      if ((statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        process.stdout.write(`[host] chmod +x ${helper}\n`);
      }
    } catch (error) {
      process.stderr.write(`[host] could not chmod ${helper}: ${error.message}\n`);
    }
  }
}
