/**
 * DSH runtime installer (DSH-WP3): resolves `@deepseek-ai/dsh@latest` from the
 * official npm registry, installs it into an immutable candidate directory,
 * atomically activates `current`, and keeps a last-known-good pointer.
 *
 * It also bootstraps the Gian-managed `gian` profile bundling
 * `@deepseek-ai/dsh-base` + `@gian/dsh-bridge` under `$DSH_HOME/profiles/gian`
 * — mirroring what `scripts/run-dsh-bridge-canary.mjs` proves for isolated
 * homes, but against the user's real (or injected) DSH home, and only creating
 * the `gian` profile (never touching other profiles).
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DshInstallerOptions {
  /** `<dataDir>/runtimes/deepseek-harness`. */
  runtimesRoot: string;
  /** `$DSH_HOME` the `gian` profile is written under. */
  dshHome: string;
  /** Absolute directory containing the @gian/dsh-bridge package. */
  bridgePackageDir: string;
  /** npm executable override (test seam). */
  npmPath?: string;
  /** Registry URL override (test seam). */
  registry?: string;
  /** Log sink. */
  log?: (message: string) => void;
}

export interface DshInstallResult {
  resolvedVersion: string;
  candidateDir: string;
  activated: boolean;
  output: string;
}

const LAST_KNOWN_GOOD_FILE = 'last-known-good.json';
const UPDATE_STATE_FILE = 'update-state.json';

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function npmExec(
  options: DshInstallerOptions,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(options.npmPath ?? 'npm', args, {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.registry ? { npm_config_registry: options.registry } : {}),
      // Isolate the managed tree from the repository workspace config.
      npm_config_workspaces: 'false',
      npm_config_ignore_scripts: 'false',
    },
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export class DshRuntimeInstaller {
  constructor(private readonly options: DshInstallerOptions) {}

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Query the official latest dist-tag (no install side effect). */
  async latestVersion(): Promise<string> {
    const { stdout } = await npmExec(
      this.options,
      ['view', '@deepseek-ai/dsh@latest', 'version'],
    );
    const version = stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`npm latest for @deepseek-ai/dsh did not report a semantic version: ${stdout.trim()}`);
    }
    return version;
  }

  /** Install latest into a fresh immutable candidate and atomically activate.
   * Preserves the previous current as last-known-good on any failure. */
  async installLatest(): Promise<DshInstallResult> {
    const version = await this.latestVersion();
    this.log(`[dsh] installing @deepseek-ai/dsh@${version}`);
    const candidate = join(this.options.runtimesRoot, version);
    const current = join(this.options.runtimesRoot, 'current');
    await mkdir(this.options.runtimesRoot, { recursive: true });
    await rm(candidate, { recursive: true, force: true });

    const install = await npmExec(this.options, [
      'install',
      '--prefix',
      candidate,
      '--no-save',
      '--no-package-lock',
      `@deepseek-ai/dsh@${version}`,
    ]);

    const bin = join(candidate, 'node_modules', '.bin', 'dsh');
    if (!(await exists(bin))) {
      await rm(candidate, { recursive: true, force: true });
      throw new Error(
        `Installed @deepseek-ai/dsh@${version} does not expose a dsh binary. ${install.stderr}`,
      );
    }

    // Bootstrap the gian profile before activation so an activated runtime is
    // always bridge-addressable.
    await this.ensureGianProfile();

    let activated = false;
    try {
      const temp = `${current}.tmp-${Date.now()}`;
      try {
        await symlink(version, temp, 'dir');
        await rename(temp, current);
      } catch (error) {
        await rm(temp, { recursive: true, force: true });
        throw error;
      }
      activated = true;
      await writeFile(
        join(this.options.runtimesRoot, LAST_KNOWN_GOOD_FILE),
        JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch (error) {
      if (!activated) {
        const previous = await this.latestInstalledVersion();
        if (previous) {
          const fallback = `${current}.${previous}`;
          await rm(fallback, { recursive: true, force: true });
          await symlink(previous, fallback, 'dir');
          await rename(fallback, current);
        }
      }
      throw error;
    }

    return {
      resolvedVersion: version,
      candidateDir: candidate,
      activated,
      output: `${install.stdout}\n${install.stderr}`.trim(),
    };
  }

  /** Record a successful non-install update check; suppresses the automatic
   * check for 24h (plan §3.3). */
  async recordUpdateCheck(): Promise<void> {
    await mkdir(this.options.runtimesRoot, { recursive: true });
    await writeFile(
      join(this.options.runtimesRoot, UPDATE_STATE_FILE),
      JSON.stringify({ checkedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  }

  async shouldAutoCheck(now = Date.now()): Promise<boolean> {
    try {
      const raw = await readFile(join(this.options.runtimesRoot, UPDATE_STATE_FILE), 'utf8');
      const state = JSON.parse(raw) as { checkedAt?: unknown };
      const checkedAt = typeof state.checkedAt === 'string' ? Date.parse(state.checkedAt) : 0;
      return now - checkedAt >= 24 * 60 * 60 * 1000;
    } catch {
      return true;
    }
  }

  async latestInstalledVersion(): Promise<string | null> {
    try {
      const raw = await readFile(join(this.options.runtimesRoot, LAST_KNOWN_GOOD_FILE), 'utf8');
      const state = JSON.parse(raw) as { version?: unknown };
      return typeof state.version === 'string' && state.version.length > 0
        ? state.version
        : null;
    } catch {
      return null;
    }
  }

  /** Create `$DSH_HOME/profiles/gian` with the bridge bundle; never touches
   * sibling profiles. */
  async ensureGianProfile(): Promise<void> {
    const profileDir = join(this.options.dshHome, 'profiles', 'gian');
    const modulesDir = join(profileDir, 'node_modules', '@gian');
    await mkdir(modulesDir, { recursive: true });
    const packagePath = join(profileDir, 'package.json');
    const packageTemp = `${packagePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(
        packageTemp,
        `${JSON.stringify({
          name: 'gian-dsh-gian-profile',
          private: true,
          dependencies: { '@gian/dsh-bridge': `file:${this.options.bridgePackageDir}` },
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'],
            },
          },
        }, null, 2)}\n`,
        'utf8',
      );
      await rename(packageTemp, packagePath);
    } catch (error) {
      await rm(packageTemp, { force: true });
      throw error;
    }
    const bridgeLink = join(modulesDir, 'dsh-bridge');
    try {
      const metadata = await lstat(bridgeLink);
      if (!metadata.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-symlink Gian DSH bridge path: ${bridgeLink}`);
      }
      if (await readlink(bridgeLink) === this.options.bridgePackageDir) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const bridgeTemp = `${bridgeLink}.tmp-${randomUUID()}`;
    try {
      await symlink(this.options.bridgePackageDir, bridgeTemp, 'dir');
      await rename(bridgeTemp, bridgeLink);
    } catch (error) {
      await rm(bridgeTemp, { force: true });
      throw error;
    }
  }
}
