#!/usr/bin/env node
// Preflight check for `pnpm install`.
//
// Bootstrap pitfall #1: better-sqlite3's native binding silently breaks on
// Node v25 — `pnpm install` and `pnpm build` both succeed, but the daemon
// crashes the first time it opens SQLite. The .npmrc has engine-strict=true
// which catches the version, but pnpm's error message is generic. This
// script runs as a preinstall hook so we can print a useful one.
//
// Bootstrap pitfall #2: brew's node frequently shadows nvm's node in PATH
// (because /opt/homebrew/bin lands ahead of ~/.nvm/... after `nvm use`).
// We detect the situation and surface workarounds.

'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_MAJOR = 22;
const MAX_MAJOR = 24; // i.e. node 25 and later are rejected

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

if (major < MIN_MAJOR || major > MAX_MAJOR) {
  console.error('');
  console.error(red(bold(`✘ Node ${version} is not supported.`)));
  console.error(`  Required: ${bold(`v${MIN_MAJOR}.x – v${MAX_MAJOR}.x`)}`);
  console.error(`  Reason:   better-sqlite3 native bindings break on Node v25+.`);
  console.error(`  Running:  ${dim(which)}`);

  const conflict = detectBrewNvmConflict();
  if (conflict) {
    console.error('');
    console.error(yellow('  ⚠ Detected brew node shadowing nvm node:'));
    console.error(`    brew: ${dim(conflict.brewNode)}`);
    console.error(`    nvm:  ${dim(conflict.nvmDir)}/<version>/bin/node`);
    console.error('');
    console.error('  One-shot fix for the current shell (replace the version dir):');
    console.error(bold(`    export PATH=~/.nvm/versions/node/v22.18.0/bin:$PATH`));
    console.error('');
    console.error('  Permanent fix (pick one):');
    console.error(`    • brew uninstall node          ${dim('# rely on nvm exclusively')}`);
    console.error(`    • brew install node@22 && brew link --force --overwrite node@22`);
  } else {
    console.error('');
    console.error('  Install or switch to a supported Node:');
    console.error(`    • nvm install 22 && nvm use 22`);
    console.error(`    • brew install node@22 && brew link --force --overwrite node@22`);
  }
  console.error('');
  process.exit(1);
}

// In-range Node — silent on success to keep install output clean.
