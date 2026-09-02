import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function safeValue(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/u.test(value)) {
    throw new Error(`${label} contains an unsupported control character`);
  }
  return value;
}

export function xmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function systemdQuote(value) {
  // systemd expands `%x` specifiers even inside quotes; `%%` is the literal
  // percent escape. Backslash and quote use systemd.syntax C-style escaping.
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

function systemdPath(value) {
  // Path-valued directives such as WorkingDirectory= do not strip shell-like
  // outer quotes. Encode characters that unit syntax tokenizes while keeping
  // the first byte as `/`, so systemd still recognizes an absolute path.
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(' ', '\\x20')
    .replaceAll('"', '\\x22')
    .replaceAll("'", '\\x27')
    .replaceAll('%', '%%');
}

function substitute(template, values) {
  const placeholder = /{{([A-Z0-9_]+)}}/g;
  const templateWithoutPlaceholders = template.replace(placeholder, '');
  if (templateWithoutPlaceholders.includes('{{') || templateWithoutPlaceholders.includes('}}')) {
    throw new Error('template contains a malformed placeholder');
  }
  // Replace every original template token in one pass. A user path may itself
  // contain `{{NODE_BIN}}`, `$&`, or another token-shaped substring; it must
  // never be scanned as template syntax after insertion.
  return template.replace(placeholder, (token, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`template contains unresolved placeholder: ${token}`);
    }
    return values[name];
  });
}

export function renderDaemonUnit({
  platform,
  template,
  installDir,
  nodeBin,
  home,
  launchdPath,
}) {
  const root = safeValue(installDir, 'installDir');
  const node = safeValue(nodeBin, 'nodeBin');
  const userHome = safeValue(home, 'home');
  if (platform === 'macos') {
    return substitute(template, {
      INSTALL_DIR: xmlText(root),
      NODE_BIN: xmlText(node),
      HOME: xmlText(userHome),
      LAUNCHD_PATH: xmlText(safeValue(launchdPath, 'launchdPath')),
    });
  }
  if (platform === 'linux') {
    return substitute(template, {
      // The `:` executable prefix disables systemd's $FOO/${FOO} expansion.
      // Gian resolves both paths before rendering, so every dollar is literal.
      EXEC_START: `:${systemdQuote(node)} ${systemdQuote(join(root, 'packages/host/dist/index.js'))}`,
      WORKING_DIRECTORY: systemdPath(join(root, 'packages/host')),
      STANDARD_OUTPUT: systemdPath(`append:${join(userHome, '.gian/logs/host.out')}`),
      STANDARD_ERROR: systemdPath(`append:${join(userHome, '.gian/logs/host.err')}`),
      ENVIRONMENT_PATH: systemdQuote(`PATH=${safeValue(launchdPath, 'launchdPath')}`),
    });
  }
  throw new Error(`unsupported daemon unit platform: ${platform}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const templatePath = safeValue(args.template, 'template');
  const outputPath = safeValue(args.output, 'output');
  const template = await readFile(templatePath, 'utf8');
  const rendered = renderDaemonUnit({
    platform: args.platform,
    template,
    installDir: args['install-dir'],
    nodeBin: args['node-bin'],
    home: args.home,
    launchdPath: args['launchd-path'] ?? '/usr/bin:/bin',
  });
  await writeFile(outputPath, rendered, { mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
