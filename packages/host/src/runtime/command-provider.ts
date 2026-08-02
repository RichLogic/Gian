import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Executor } from '@gian/shared';
import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeSource,
} from './types.js';

const execFileAsync = promisify(execFile);

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

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
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
      for (const path of this.options.officialPaths()) {
        candidates.push({ path, source: 'official-user' });
      }
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
    }

    const installed: InstalledRuntime[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      try {
        await access(candidate.path, constants.X_OK);
        const binaryPath = await realpath(candidate.path);
        if (!isAbsolute(binaryPath) || seen.has(binaryPath)) continue;
        seen.add(binaryPath);
        installed.push({ cli: this.id, binaryPath, source: candidate.source });
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

  async probe(runtime: InstalledRuntime): Promise<RuntimeProbe> {
    if (!isAbsolute(runtime.binaryPath)) {
      throw new Error(`resolved ${this.id} binary path is not absolute`);
    }
    await access(runtime.binaryPath, constants.X_OK);
    const result = await execFileAsync(runtime.binaryPath, ['--version'], {
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...this.managedEnv() },
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
    };
  }

  managedEnv(): Readonly<Record<string, string>> {
    return this.options.env ?? {};
  }
}
