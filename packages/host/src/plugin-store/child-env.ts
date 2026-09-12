import {
  RUNTIME_BOOTSTRAP_ENV,
  RUNTIME_BOOTSTRAP_VALUE,
} from '@gian/proxy-protocol';

/** Minimized/redacted child environment: no Runtime, no model, no secrets. */
export function pluginChildEnvironment(input: {
  pluginId: string;
  protocolVersions: readonly string[];
  dataDir?: string;
  bootstrap?: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    GIAN_PLUGIN_ID: input.pluginId,
    GIAN_PROTOCOL_VERSIONS: input.protocolVersions.join(','),
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (input.dataDir) env.GIAN_PLUGIN_DATA_DIR = input.dataDir;
  if (input.bootstrap) {
    env[RUNTIME_BOOTSTRAP_ENV] = RUNTIME_BOOTSTRAP_VALUE;
  }
  delete env.GIAN_RUNTIME_BIN;
  return env;
}
