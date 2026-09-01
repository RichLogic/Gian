/**
 * DSH runtime provider (DSH-WP3 core): resolves `@deepseek-ai/dsh` from the
 * Gian-managed immutable runtime tree, the official npm global bin, a user
 * home install, PATH, or an explicit override — then probes `dsh --version`
 * without any model calls.
 *
 * Unlike the other executors DSH has no shell installer. The managed runtime
 * keeps `<dataDir>/runtimes/deepseek-harness/<resolved-version>/` immutable
 * with `current -> <resolved-version>` as the atomic activation pointer. The
 * `dsh` binary inside it is the profile launcher (`node_modules/.bin/dsh`);
 * the Host hands it to dsh-proxy, which boots `--profile gian` and mounts the
 * `@gian/dsh-bridge` bundle on stdio.
 */

import { constants } from 'node:fs';
import { access, readlink, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { runProtectedCommand } from './protected-command.js';
import { runtimeContentSnapshot } from './content-snapshot.js';
import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeProcessGroupProtector,
} from './types.js';

export interface DshRuntimeProviderOptions {
  dataDir: string;
  overridePath?: string;
  /** Base directory for managed immutable DSH runtimes. */
  runtimesRoot?: string;
  pathEnv?: string;
}

interface Candidate {
  path: string;
  source: 'override' | 'managed' | 'official-user' | 'path';
}

function uniquePath(entries: Array<string | undefined>): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of entries) {
    for (const entry of (value ?? '').split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result.join(delimiter);
}

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export class DshRuntimeProvider implements CliRuntimeProvider {
  readonly id = 'dsh' as const;

  constructor(private readonly options: DshRuntimeProviderOptions) {}

  private runtimesRoot(): string {
    return this.options.runtimesRoot ?? join(this.options.dataDir, 'runtimes', 'deepseek-harness');
  }

  private fromCurrentSymlink(): string {
    const current = join(this.runtimesRoot(), 'current');
    return current;
  }

  async inspectInstalled(overridePath?: string): Promise<InstalledRuntime[]> {
    const candidates: Candidate[] = [];
    const override = (overridePath ?? this.options.overridePath)?.trim();
    if (override) {
      if (!isAbsolute(override)) {
        throw new Error('DSH_RUNTIME_BIN must be an absolute path.');
      }
      candidates.push({ path: override, source: 'override' });
    } else {
      // Immutable managed runtime: current/node_modules/.bin/dsh.
      candidates.push({
        path: join(this.fromCurrentSymlink(), 'node_modules', '.bin', 'dsh'),
        source: 'managed',
      });
      // User-installed DSH CLI (npm global) shares PATH rather than a fixed home.
      for (const dir of (this.options.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
        if (dir.trim()) {
          candidates.push({ path: resolve(dir, 'dsh'), source: 'path' });
        }
      }
    }

    const seen = new Set<string>();
    const installed: InstalledRuntime[] = [];
    for (const candidate of candidates) {
      try {
        await access(candidate.path, constants.X_OK);
        const canonicalPath = await realpath(candidate.path);
        if (!isAbsolute(canonicalPath) || seen.has(canonicalPath)) continue;
        seen.add(canonicalPath);
        // Keep the npm launcher path. Resolving `.bin/dsh` to its JavaScript
        // target makes `/usr/bin/env node` depend on the Finder-launched App's
        // minimal PATH and loses the launcher identity used by snapshots.
        installed.push({
          cli: this.id,
          binaryPath: candidate.path,
          source: candidate.source,
        });
      } catch {
        if (candidate.source === 'override') {
          // Preserve the explicit candidate so probe emits an actionable
          // failure instead of falling through to a different installation.
          installed.push({
            cli: this.id,
            binaryPath: candidate.path,
            source: candidate.source,
          });
        }
      }
    }
    return installed;
  }

  async probe(
    runtime: InstalledRuntime,
    protector?: RuntimeProcessGroupProtector,
  ): Promise<RuntimeProbe> {
    if (!isAbsolute(runtime.binaryPath)) {
      throw new Error('resolved DSH binary path is not absolute');
    }
    await access(runtime.binaryPath, constants.X_OK);
    const result = await runProtectedCommand({
      command: runtime.binaryPath,
      args: ['--version'],
      timeoutMs: 8_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...this.managedEnv(),
      },
      label: 'dsh --version',
      ...(protector ? { protector } : {}),
    });
    const version = firstVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      throw new Error('`dsh --version` did not report a semantic version');
    }
    return {
      cli: this.id,
      binaryPath: runtime.binaryPath,
      version,
      source: runtime.source,
    };
  }

  managedEnv(): Readonly<Record<string, string>> {
    return {
      // The proxy boots the bridge via `--profile gian`; the runtime binary
      // is only used as the profile launcher.
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // Packaged Gian starts Host with its bundled Node as process.execPath,
      // but a Finder launch does not put that directory on PATH. npm's DSH
      // launcher uses `#!/usr/bin/env node`, so make that exact runtime
      // discoverable for both the version probe and the Proxy child.
      PATH: uniquePath([
        dirname(process.execPath),
        this.options.pathEnv,
        process.env.PATH,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]),
    };
  }

  snapshot(runtime: InstalledRuntime | RuntimeProbe): Promise<string> {
    return runtimeContentSnapshot(runtime.binaryPath);
  }

  /** Resolve the activation pointer without touching the filesystem. */
  async currentVersion(): Promise<string | null> {
    try {
      const current = this.fromCurrentSymlink();
      let target: string;
      try {
        target = await readlink(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL') throw error;
        target = current;
      }
      const resolved = await realpath(target);
      return resolved.split(/[\\/]/).at(-1) ?? null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      return null;
    }
  }
}
