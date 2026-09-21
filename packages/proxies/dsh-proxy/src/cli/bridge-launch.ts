/**
 * Bridge child launch resolution for the DSH Proxy CLI.
 *
 * Kept free of side effects so tests can cover the spawn plan directly;
 * `spawn.ts` owns the process entrypoint.
 */

export interface BridgeLaunch {
  bridgeCommand: string;
  args: string[];
  /**
   * True when the proxy owns the DSH boot (command from GIAN_RUNTIME_BIN /
   * DSH_HOST_ENTRY with derived `--profile gian` args) and must ensure the
   * `gian` profile exists before spawning. False when any override
   * (--bridge=, GIAN_DSH_HOST_ENTRY, GIAN_DSH_HOST_ARGS) signals an
   * externally managed bridge.
   */
  managedProfile: boolean;
}

export function bridgeArgs(argv: string[], explicit: string | undefined): string[] {
  const configured = process.env.GIAN_DSH_HOST_ARGS;
  if (configured !== undefined) {
    const parsed = JSON.parse(configured) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
      throw new Error('GIAN_DSH_HOST_ARGS must be a JSON array of strings.');
    }
    return parsed;
  }
  const extraArgs = argv.filter((arg) => arg.startsWith('--') === false);
  // The protocol client passes the DSH profile launcher via GIAN_RUNTIME_BIN.
  // An explicit test bridge is already a bridge/1.0 stdio entry; the real DSH
  // launcher always needs `--profile gian` so the bridge bundle mounts on
  // stdout (plan §3.4: shared Host running profile "gian").
  return explicit !== undefined
    ? extraArgs
    : ['--profile', 'gian', ...extraArgs];
}

/**
 * The packaged app's Node binary is Team-ID-signed with the hardened runtime,
 * so macOS library validation refuses to dlopen DSH's adhoc-signed
 * node-addon-require-builtin addon. DSH's cordis loader falls back to Node's
 * internal ESM loader when `--expose-internals` is present in execArgv, so a
 * `.js` bridge command is launched through the current Node executable with
 * that flag instead of relying on the script's shebang.
 */
export function resolveNodeLauncher(launch: Omit<BridgeLaunch, 'managedProfile'>): Omit<BridgeLaunch, 'managedProfile'> {
  if (!launch.bridgeCommand.endsWith('.js')) return launch;
  return {
    bridgeCommand: process.execPath,
    args: ['--expose-internals', launch.bridgeCommand, ...launch.args],
  };
}

export function parseArgs(argv: string[]): BridgeLaunch {
  const explicit = argv.find((arg) => arg.startsWith('--bridge='))?.slice('--bridge='.length);
  const command = process.env.GIAN_DSH_HOST_ENTRY
    ?? explicit
    ?? process.env.GIAN_RUNTIME_BIN
    ?? process.env.DSH_HOST_ENTRY
    ?? null;
  if (!command) {
    throw new Error('dsh-proxy requires GIAN_DSH_HOST_ENTRY (or --bridge=<path>) to the DSH host entry.');
  }
  const managedProfile = explicit === undefined
    && process.env.GIAN_DSH_HOST_ENTRY === undefined
    && process.env.GIAN_DSH_HOST_ARGS === undefined;
  return {
    ...resolveNodeLauncher({ bridgeCommand: command, args: bridgeArgs(argv, explicit) }),
    managedProfile,
  };
}
