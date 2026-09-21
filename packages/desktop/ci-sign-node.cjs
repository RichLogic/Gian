// Signs the bundled Node runtime (Contents/Resources/runtime/node) with its own
// entitlements (resources/entitlements.mac.node.plist) instead of the inherited
// App/helper set. electron-builder skips this binary via mac.signIgnore, so this
// afterPack hook is its only signer; the App and helpers keep library validation
// enforced while Node gains the exception managed JS runtimes need for their
// upstream-adhoc-signed native addons.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const NODE_ENTITLEMENTS = join('resources', 'entitlements.mac.node.plist');
const BUNDLED_NODE = join('Contents', 'Resources', 'runtime', 'node');
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation',
];

function findDeveloperIdIdentity(keychain) {
  const args = ['find-identity', '-v', '-p', 'codesigning'];
  if (keychain) args.push(keychain);
  const output = execFileSync('security', args, { encoding: 'utf8' });
  const match = output.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"Developer ID Application:[^"]+"/m);
  if (!match) throw new Error('No "Developer ID Application" codesigning identity found for the bundled Node runtime');
  return match[1];
}

function signBundledNode(appPath, { identity, keychain, projectDir }) {
  const node = join(appPath, BUNDLED_NODE);
  if (!existsSync(node)) throw new Error(`Bundled Node runtime is missing: ${node}`);
  const adhoc = identity === '-';
  const args = ['--force', '--sign', adhoc ? '-' : findDeveloperIdIdentity(keychain), '--options', 'runtime'];
  // Ad-hoc signatures cannot use a timestamp authority server.
  args.push(adhoc ? '--timestamp=none' : '--timestamp');
  if (!adhoc && keychain) args.push('--keychain', keychain);
  args.push('--entitlements', join(projectDir, NODE_ENTITLEMENTS), node);
  execFileSync('codesign', args, { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', node]);
  const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', node], { encoding: 'utf8' });
  for (const key of REQUIRED_ENTITLEMENTS) {
    if (!xml.includes(`<key>${key}</key>`)) throw new Error(`Bundled Node runtime is missing entitlement: ${key}`);
  }
  return node;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { assertExecutionAllowed } = await import('../../scripts/execution-policy.mjs');
  assertExecutionAllowed('package');
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  signBundledNode(appPath, {
    identity: context.packager.platformSpecificBuildOptions.identity,
    keychain: process.env.CSC_KEYCHAIN,
    projectDir: context.packager.projectDir,
  });
};
module.exports.signBundledNode = signBundledNode;
module.exports.BUNDLED_NODE = BUNDLED_NODE;
