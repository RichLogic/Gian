#!/usr/bin/env node
// Preflight check for `pnpm install`.
//
// Gian pins Node 24 LTS so local native dependencies use the same ABI as the
// bundled desktop Host. The .npmrc has engine-strict=true, but pnpm's error is
// generic. This preinstall hook prints a useful recovery path.
//
// Bootstrap pitfall #2: brew's node frequently shadows nvm's node in PATH
// (because /opt/homebrew/bin lands ahead of ~/.nvm/... after `nvm use`).
// We detect the situation and surface workarounds.

'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_MAJOR = 24;

const version = process.versions.node;
const major = Number(version.split('.')[0]);
const which = process.execPath;

function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }

function detectBrewNvmConflict() {
  const home = os.homedir();
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  if (!fs.existsSync(nvmDir)) return null;
  let brewNode = '';
  try {
    brewNode = cp.execSync('ls /opt/homebrew/bin/node 2>/dev/null || ls /usr/local/bin/node 2>/dev/null', {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
  if (!brewNode) return null;
  // Both nvm and brew node exist. If the running Node isn't from nvm, flag it.
  if (!which.includes('/.nvm/')) {
    return { brewNode, nvmDir };
  }
  return null;
}

if (major !== REQUIRED_MAJOR) {
  console.error('');
  console.error(red(bold(`✘ Node ${version} is not supported.`)));
  console.error(`  Required: ${bold(`v${REQUIRED_MAJOR}.x`)}`);
  console.error('  Reason:   Gian pins its source and packaged Host to one Node LTS ABI.');
  console.error(`  Running:  ${dim(which)}`);

  const conflict = detectBrewNvmConflict();
  if (conflict) {
    console.error('');
    console.error(yellow('  ⚠ Detected brew node shadowing nvm node:'));
    console.error(`    brew: ${dim(conflict.brewNode)}`);
    console.error(`    nvm:  ${dim(conflict.nvmDir)}/<version>/bin/node`);
    console.error('');
    console.error('  One-shot fix for the current shell:');
    console.error(bold('    nvm install 24 && nvm use 24'));
    console.error('');
    console.error('  Permanent fix (pick one):');
    console.error(`    • brew uninstall node          ${dim('# rely on nvm exclusively')}`);
    console.error('    • nvm install 24 && nvm alias default 24');
  } else {
    console.error('');
    console.error('  Install or switch to a supported Node:');
    console.error('    • nvm install 24 && nvm use 24');
    console.error('    • install the official Node.js 24 binary from nodejs.org');
  }
  console.error('');
  process.exit(1);
}

// Node 24 — silent on success to keep install output clean.
