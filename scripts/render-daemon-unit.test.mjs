import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { renderDaemonUnit } from './render-daemon-unit.mjs';

const execFileAsync = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const installerUname = process.platform === 'darwin'
  ? 'Darwin'
  : process.platform === 'linux'
    ? 'Linux'
    : undefined;
const installerPlatform = installerUname === 'Darwin' ? 'macos' : 'linux';

function requireInstallerHost(t) {
  if (installerUname) return true;
  t.skip(`unsupported test host: ${process.platform}`);
  return false;
}

test('ERR-017: launchd rendering XML-escapes special paths and passes plutil', async t => {
  if (!existsSync('/usr/bin/plutil')) {
    t.skip('plutil is only available on macOS');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'gian-plist-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installDir = '/tmp/Gian & <repo> "quoted" % {{NODE_BIN}} $&';
  const nodeBin = '/tmp/Node & Tools/node';
  const home = '/tmp/Home & <user> %';
  const launchdPath = '/tmp/bin & tools:/usr/bin';
  const template = await readFile(join(scriptsDir, 'install/macos/com.gian.host.plist'), 'utf8');
  const rendered = renderDaemonUnit({
    platform: 'macos', template, installDir, nodeBin, home, launchdPath,
  });
  const output = join(directory, 'com.gian.host.plist');
  await writeFile(output, rendered);

  await execFileAsync('/usr/bin/plutil', ['-lint', output]);
  const converted = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', output], {
    encoding: 'utf8',
  });
  const plist = JSON.parse(converted.stdout);
  assert.deepEqual(plist.ProgramArguments, [nodeBin, `${installDir}/packages/host/dist/index.js`]);
  assert.equal(plist.WorkingDirectory, `${installDir}/packages/host`);
  assert.equal(plist.StandardOutPath, `${home}/.gian/logs/host.out`);
  assert.equal(plist.EnvironmentVariables.PATH, launchdPath);
});

test('ERR-017: systemd rendering quotes spaces and escapes percent specifiers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-systemd-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installDir = '/srv/Gian & 100% ${ROOT} ready';
  const nodeBin = '/opt/Node 22%/$runtime/node';
  const home = '/home/user name%';
  const launchdPath = '/opt/Kimi 100%:/usr/bin';
  const template = await readFile(join(scriptsDir, 'install/linux/gian.service'), 'utf8');
  const rendered = renderDaemonUnit({
    platform: 'linux', template, installDir, nodeBin, home, launchdPath,
  });
  assert.match(rendered, /ExecStart="\/opt\/Node 22%%\/\$\$runtime\/node" "\/srv\/Gian & 100%% \$\$\{ROOT\} ready\/packages\/host\/dist\/index\.js"/);
  assert.match(rendered, /WorkingDirectory="\/srv\/Gian & 100%% \$\{ROOT\} ready\/packages\/host"/);
  assert.match(rendered, /Environment="PATH=\/opt\/Kimi 100%%:\/usr\/bin"/);
  assert.match(rendered, /StandardOutput="append:\/home\/user name%%\/\.gian\/logs\/host\.out"/);
  assert.doesNotMatch(rendered, /{{[A-Z0-9_]+}}/);

  if (spawnSync('systemd-analyze', ['--version']).status === 0) {
    const verifiedRoot = join(directory, 'Gian 100% $root');
    const verifiedNode = join(directory, 'Node 100% $runtime', 'node');
    const verifiedHome = join(directory, 'Home 100% $user');
    await mkdir(dirname(verifiedNode), { recursive: true });
    await mkdir(join(verifiedRoot, 'packages/host/dist'), { recursive: true });
    await mkdir(join(verifiedHome, '.gian/logs'), { recursive: true });
    await symlink(process.execPath, verifiedNode);
    await writeFile(join(verifiedRoot, 'packages/host/dist/index.js'), '// fixture\n');
    const verifiedUnit = renderDaemonUnit({
      platform: 'linux',
      template,
      installDir: verifiedRoot,
      nodeBin: verifiedNode,
      home: verifiedHome,
      launchdPath: `${dirname(verifiedNode)}:/usr/bin`,
    });
    const output = join(directory, 'gian.service');
    await writeFile(output, verifiedUnit);
    const verified = spawnSync('systemd-analyze', ['verify', output], { encoding: 'utf8' });
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  }
});

async function writeExecutable(path, source) {
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function installFixture() {
  const base = await mkdtemp(join(tmpdir(), 'gian-install-matrix-'));
  const root = join(base, 'Gian repo & <special> 100%');
  await mkdir(join(root, 'scripts/install/macos'), { recursive: true });
  await mkdir(join(root, 'scripts/install/linux'), { recursive: true });
  await mkdir(join(root, 'packages/host/dist'), { recursive: true });
  await cp(join(scriptsDir, 'install.sh'), join(root, 'scripts/install.sh'));
  await cp(join(scriptsDir, 'render-daemon-unit.mjs'), join(root, 'scripts/render-daemon-unit.mjs'));
  await cp(
    join(scriptsDir, 'install/macos/com.gian.host.plist'),
    join(root, 'scripts/install/macos/com.gian.host.plist'),
  );
  await cp(
    join(scriptsDir, 'install/linux/gian.service'),
    join(root, 'scripts/install/linux/gian.service'),
  );
  await writeFile(join(root, 'packages/host/dist/index.js'), '// fixture\n');
  await chmod(join(root, 'scripts/install.sh'), 0o755);
  const bin = join(base, 'fixture bin');
  await mkdir(bin);
  for (const command of ['claude', 'codex', 'kimi']) {
    await writeExecutable(join(bin, command), '#!/bin/sh\nexit 0\n');
  }
  const home = join(base, 'Home & <user> 100%');
  await mkdir(home);
  return { base, root, bin, home };
}

async function setFakeRuntime(bin, platform, version) {
  await writeExecutable(join(bin, 'uname'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(platform)}\n`);
  await writeExecutable(join(bin, 'node'), `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' ${JSON.stringify(version)}
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
}

async function runCheck(fixture, options = {}) {
  return execFileAsync(join(fixture.root, 'scripts/install.sh'), ['--check'], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      HOME: fixture.home,
      TMPDIR: fixture.base,
      PATH: options.path ?? `${fixture.bin}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });
}

test('ERR-017: relative PATH entries become absolute daemon executable paths', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  await setFakeRuntime(fixture.bin, installerUname, 'v22.18.0');

  const result = await runCheck(fixture, {
    cwd: fixture.base,
    path: `${fixture.bin.slice(fixture.base.length + 1)}:/usr/bin:/bin`,
  });
  const absoluteBin = await realpath(fixture.bin);
  assert.ok(
    result.stdout.includes(`Node        : ${join(absoluteBin, 'node')}`),
    result.stdout,
  );
  assert.ok(result.stdout.includes(`Launch PATH : ${absoluteBin}:`), result.stdout);
});

test('ERR-017: version validation checks the resolved binary, not a shell function', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  await setFakeRuntime(fixture.bin, installerUname, 'v22.18.0');
  await writeExecutable(join(fixture.bin, 'bash'), `#!/bin/bash
node() { printf 'v25.0.0\\n'; }
export -f node
exec /bin/bash "$@"
`);

  const result = await runCheck(fixture);
  assert.match(result.stdout, /Node\s+: .* \(v22\.18\.0\)/);
});

test('ERR-017: daemon PATH rejects unrepresentable control characters', async t => {
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const controlBin = join(fixture.base, 'node\ninjected');
  await mkdir(controlBin);
  await setFakeRuntime(controlBin, 'Darwin', 'v22.18.0');

  await assert.rejects(
    runCheck(fixture, { path: `${controlBin}:${fixture.bin}:/usr/bin:/bin` }),
    error => {
      assert.match(error.stderr, /PATH directory contains an unsupported colon or control character/);
      return true;
    },
  );
});

test('ERR-017: renderer rejects non-printing unit values', () => {
  assert.throws(
    () => renderDaemonUnit({
      platform: 'linux',
      template: 'ExecStart={{EXEC_START}}\n',
      installDir: '/srv/Gian\tinvalid',
      nodeBin: '/usr/bin/node',
      home: '/home/user',
      launchdPath: '/usr/bin:/bin',
    }),
    /unsupported control character/,
  );
});

test('ERR-017: install --check validates the host platform with special paths', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  await setFakeRuntime(fixture.bin, installerUname, 'v22.18.0');
  const result = await runCheck(fixture);
  assert.match(result.stdout, new RegExp(`Rendered ${installerPlatform} unit successfully`));
});

test('DAEMON-001: install --check renders the Linux systemd user unit', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  await setFakeRuntime(fixture.bin, 'Linux', 'v22.18.0');

  const result = await runCheck(fixture);
  assert.match(result.stdout, /Rendered linux unit successfully/);
  assert.match(result.stdout, /Launch PATH/);
});

test('ERR-017: install failure matrix rejects unsupported Node and missing build entry', async t => {
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));

  await setFakeRuntime(fixture.bin, 'Darwin', 'v21.9.0');
  await assert.rejects(runCheck(fixture), error => {
    assert.match(error.stderr, /Node v22\+ required/);
    return true;
  });

  await setFakeRuntime(fixture.bin, 'Darwin', 'v25.0.0');
  await assert.rejects(runCheck(fixture), error => {
    assert.match(error.stderr, /Node v25\+ silently breaks better-sqlite3/);
    assert.match(error.stderr, /brew is shadowing nvm/);
    return true;
  });

  await unlink(join(fixture.root, 'packages/host/dist/index.js'));
  await setFakeRuntime(fixture.bin, 'Darwin', 'v22.18.0');
  await assert.rejects(runCheck(fixture), error => {
    assert.match(error.stderr, /Built entry point not found/);
    return true;
  });
});

test('ERR-017: a Homebrew Node 25 shadowing an nvm Node 22 fails explicitly', async t => {
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const brewBin = join(fixture.base, 'homebrew', 'bin');
  await mkdir(brewBin, { recursive: true });
  await setFakeRuntime(fixture.bin, 'Darwin', 'v22.18.0');
  await writeExecutable(join(brewBin, 'node'), '#!/bin/sh\nprintf "v25.0.0\\n"\n');

  await assert.rejects(
    runCheck(fixture, { path: `${brewBin}:${fixture.bin}:/usr/bin:/bin` }),
    error => {
      assert.match(error.stderr, /Node v25\+ silently breaks better-sqlite3/);
      assert.match(error.stderr, /brew is shadowing nvm/);
      return true;
    },
  );
});

test('ERR-017: missing provider CLIs stay non-fatal and identify every deferred install', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  for (const command of ['claude', 'codex', 'kimi']) {
    await unlink(join(fixture.bin, command));
  }
  await setFakeRuntime(fixture.bin, installerUname, 'v22.18.0');

  const result = await runCheck(fixture);
  assert.match(result.stdout, new RegExp(`Rendered ${installerPlatform} unit successfully`));
  assert.match(result.stderr, /warn: claude not found on \$PATH/);
  assert.match(result.stderr, /warn: codex not found on \$PATH/);
  assert.match(result.stderr, /warn: kimi not found on \$PATH/);
});

test('ERR-017: Node 24 is accepted and a Kimi-only directory enters daemon PATH', async t => {
  if (!requireInstallerHost(t)) return;
  const fixture = await installFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const kimiBin = join(fixture.base, 'kimi-only bin');
  await mkdir(kimiBin);
  await unlink(join(fixture.bin, 'kimi'));
  await writeExecutable(join(kimiBin, 'kimi'), '#!/bin/sh\nexit 0\n');
  await setFakeRuntime(fixture.bin, installerUname, 'v24.9.0');

  const result = await runCheck(fixture, {
    path: `${fixture.bin}:${kimiBin}:/usr/bin:/bin`,
  });
  assert.match(result.stdout, /Node\s+: .* \(v24\.9\.0\)/);
  assert.ok(result.stdout.includes(`:${kimiBin}:`), result.stdout);
});
