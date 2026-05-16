#!/usr/bin/env node
// pnpm strips the +x bit when extracting node-pty's prebuilt `spawn-helper`
// binary (it ships as `-rw-r--r--` inside the tarball after pnpm rehashes).
// Without it node-pty's `spawn()` fails at runtime with `posix_spawnp
// failed.` — the actual `claude` PTY never starts.
//
// We can't fix it inside node-pty (third-party) and we can't rely on the
// global preinstall (different node-pty install paths land in different
// .pnpm subdirs). Run it as a per-package postinstall so it picks up the
// node-pty layer this proxy is wired against.
//
// Idempotent: chmod 0755 is a no-op when the bit is already set.

const { existsSync, chmodSync, readdirSync, statSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

function findNodePtyRoots(start) {
  // Walk up from this script toward the repo root, scanning each
  // `node_modules/.pnpm/node-pty@*/node_modules/node-pty` plus any direct
  // `node_modules/node-pty`. Returns every match we find — pnpm hoists into
  // both the workspace root and the package's own node_modules sometimes.
  const found = new Set();
  let dir = resolve(start);
  while (true) {
    const direct = join(dir, 'node_modules', 'node-pty');
    if (existsSync(direct)) found.add(direct);

    const pnpm = join(dir, 'node_modules', '.pnpm');
    if (existsSync(pnpm)) {
      for (const entry of readdirSync(pnpm)) {
        if (!entry.startsWith('node-pty@')) continue;
        const inner = join(pnpm, entry, 'node_modules', 'node-pty');
        if (existsSync(inner)) found.add(inner);
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return Array.from(found);
}

const PLATFORM_DIRS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

let fixedAny = false;
for (const root of findNodePtyRoots(__dirname)) {
  for (const platform of PLATFORM_DIRS) {
    const helper = join(root, 'prebuilds', platform, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        process.stdout.write(`[cc-proxy] chmod +x ${helper}\n`);
        fixedAny = true;
      }
    } catch (err) {
      process.stderr.write(`[cc-proxy] could not chmod ${helper}: ${err.message}\n`);
    }
  }
}
if (!fixedAny) {
  // Silent on the common case where the bit is already set.
}
