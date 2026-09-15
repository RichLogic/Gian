import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_PLAN = 'gian-desktop-v1';
export const DESKTOP_CHECKS = ['packaged-lifecycle', 'gatekeeper', 'notifications', 'restart-recovery'];
export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
export function isPublicPath(path) {
  return !/^(AGENTS\.md|CLAUDE\.md|ONBOARDING\.md)$/.test(path)
    && !/^(docs|design|e2e|\.agents|\.claude|\.codex|\.ai|\.cursor)\//.test(path)
    && !/^\.github\/workflows\/(ci|dev-package|nightly-e2e)\.yml$/.test(path);
}
export function publicManifest(revision = 'HEAD', cwd = process.cwd(), includePrivate = false) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', revision], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot read curated source tree');
  return result.stdout.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), mode, type, oid };
  }).filter(entry => includePrivate || isPublicPath(entry.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function assertSourceCertificate(certificate, run, manifest) {
  if (certificate.schema !== 1 || certificate.status !== 'PASS' || certificate.full !== true
    || !/^[1-9][0-9]*$/.test(String(certificate.runAttempt))
    || certificate.repository !== 'RichLogic/Gian-Dev' || certificate.sha !== run.head_sha
    || String(certificate.runId) !== String(run.id) || run.conclusion !== 'success'
    || String(certificate.runAttempt) !== String(run.run_attempt)
    || run.head_branch !== 'main' || run.event === 'pull_request'
    || run.path !== '.github/workflows/ci.yml'
    || run.repository?.full_name !== certificate.repository) throw new Error('Untrusted/incomplete source certificate');
  if (JSON.stringify(certificate.manifest) !== JSON.stringify(manifest)) throw new Error('Curated source differs from certified GianDev tree');
}
export function releaseAssets(directory) {
  return readdirSync(directory).filter(name => /\.(dmg|zip|blockmap)$/.test(name) || ['latest-mac.yml', 'SHA256SUMS'].includes(name)).sort().map(name => {
    const bytes = readFileSync(join(directory, name));
    return { name, size: bytes.length, sha256: sha256(bytes) };
  });
}
export function assertDesktopAcceptance(receipt, build, assets) {
  if (receipt.schema !== 1 || receipt.plan !== DESKTOP_PLAN || receipt.status !== 'PASS'
    || receipt.sha !== build.sha || receipt.version !== build.version
    || String(receipt.buildRunId) !== String(build.runId)
    || receipt.bundleId !== 'com.gian.desktop' || receipt.platform !== 'darwin'
    || receipt.arch !== 'arm64' || typeof receipt.macos !== 'string' || !receipt.macos
    || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) > Date.now() + 60000
    || Date.now() - Date.parse(receipt.completedAt) > 7 * 86400000) throw new Error('Invalid/stale Desktop acceptance');
  const required = build.version === '0.6.0' ? DESKTOP_CHECKS : [...DESKTOP_CHECKS, 'auto-update'];
  for (const id of required) if (receipt.checks?.[id] !== 'PASS') throw new Error(`Missing Desktop evidence: ${id}`);
  if (JSON.stringify(build.assets) !== JSON.stringify(assets)
    || JSON.stringify(receipt.assets) !== JSON.stringify(assets)) throw new Error('Accepted assets were replaced or rebuilt');
}
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function main(args = process.argv.slice(2)) {
  const [mode, ...values] = args;
  if (mode === 'source') {
    writeFileSync('source-certificate.json', JSON.stringify({ schema: 1, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, node: process.version, repository: process.env.GITHUB_REPOSITORY, full: process.env.FULL === 'true', status: 'PASS', manifest: publicManifest() }, null, 2) + '\n');
  } else if (mode === 'verify-source') {
    if (publicManifest('HEAD', process.cwd(), true).some(entry => !isPublicPath(entry.path))) throw new Error('Internal files are present in public source');
    assertSourceCertificate(json(values[0]), json(values[1]), publicManifest());
  } else if (mode === 'build') {
    const version = json('package.json').version;
    writeFileSync(join(values[0], 'release-build-receipt.json'), JSON.stringify({ schema: 1, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, version, assets: releaseAssets(values[0]) }, null, 2) + '\n');
  } else if (mode === 'acceptance-template') {
    const build = json(values[0]);
    const checks = Object.fromEntries([...DESKTOP_CHECKS, 'auto-update'].map(id => [id, 'NOT_RUN']));
    writeFileSync(values[1], JSON.stringify({ schema: 1, plan: DESKTOP_PLAN, status: 'NOT_RUN', sha: build.sha, version: build.version, buildRunId: build.runId, bundleId: 'com.gian.desktop', platform: 'darwin', arch: 'arm64', macos: '', completedAt: '', checks, assets: build.assets }, null, 2) + '\n', { flag: 'wx' });
  } else if (mode === 'verify-acceptance') {
    if (!/^[a-f0-9]{64}$/.test(values[3] ?? '') || sha256(readFileSync(values[0])) !== values[3]) throw new Error('Acceptance receipt differs from maintainer-approved hash');
    assertDesktopAcceptance(json(values[0]), json(values[1]), releaseAssets(values[2]));
  } else throw new Error(`Unknown certificate operation: ${basename(mode ?? '')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
