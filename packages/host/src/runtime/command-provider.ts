import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import type { Executor } from '@gian/shared';
import { runProtectedCommand } from './protected-command.js';
import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeProcessGroupProtector,
  RuntimeSource,
} from './types.js';

export interface CommandRuntimeProviderOptions {
  id: Executor;
  command: string;
  configuredPath: () => string | undefined;
  officialPaths: () => string[];
  pathEnv?: () => string | undefined;
  env?: Readonly<Record<string, string>>;
}
interface Candidate {
  path: string;
  source: RuntimeSource;
}

const SYSTEM_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
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

export class CommandRuntimeProvider implements CliRuntimeProvider {
  readonly id: Executor;

  constructor(private readonly options: CommandRuntimeProviderOptions) {
    this.id = options.id;
  }

  async inspectInstalled(): Promise<InstalledRuntime[]> {
    const configured = this.options.configuredPath()?.trim();
    const candidates: Candidate[] = [];
    if (configured) {
      if (!isAbsolute(configured)) {
        throw new Error(`${this.id} CLI path must be absolute.`);
      }
      candidates.push({ path: configured, source: 'override' });
    } else {
      for (const directory of (
        this.options.pathEnv?.() ?? process.env.PATH ?? ''
      ).split(delimiter)) {
        if (directory.trim()) {
          candidates.push({
            path: resolve(directory, this.options.command),
            source: 'path',
          });
        }
      }
      for (const path of this.options.officialPaths()) {
        candidates.push({ path, source: 'official-user' });
      }
    }

    const installed: InstalledRuntime[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      try {
        await access(candidate.path, constants.X_OK);
        const canonicalPath = await realpath(candidate.path);
        if (!isAbsolute(canonicalPath) || seen.has(canonicalPath)) continue;
        seen.add(canonicalPath);
        // Keep the launcher path. Resolving an npm-style symlink to its JS
        // target bypasses the directory that also contains its Node runtime.
        installed.push({
          cli: this.id,
          binaryPath: candidate.path,
          source: candidate.source,
        });
      } catch {
        if (candidate.source === 'override') {
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
      throw new Error(`resolved ${this.id} binary path is not absolute`);
    }
    await access(runtime.binaryPath, constants.X_OK);
    const runtimeEnv = this.runtimeEnv(runtime);
    const result = await runProtectedCommand({
      command: runtime.binaryPath,
      args: ['--version'],
      timeoutMs: 8_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...runtimeEnv },
      label: `${this.options.command} --version`,
      ...(protector ? { protector } : {}),
    });
    const version = firstVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      throw new Error(`\`${this.options.command} --version\` did not report a semantic version`);
    }
    return {
      cli: this.id,
      binaryPath: runtime.binaryPath,
      version,
      source: runtime.source,
      env: runtimeEnv,
    };
  }

  managedEnv(): Readonly<Record<string, string>> {
    return this.options.env ?? {};
  }

  private runtimeEnv(runtime: InstalledRuntime): Readonly<Record<string, string>> {
    const managed = this.managedEnv();
    const officialDirectories = this.options.officialPaths().map(path => dirname(path));
    return {
      ...managed,
      PATH: uniquePath([
        dirname(runtime.binaryPath),
        managed.PATH,
        this.options.pathEnv?.(),
        process.env.PATH,
        ...officialDirectories,
        ...SYSTEM_PATHS,
      ]),
    };
  }
}
