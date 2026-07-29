import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeSource,
} from './types.js';

const execFileAsync = promisify(execFile);

export interface KimiRuntimeProviderOptions {
  dataDir: string;
  overridePath?: string;
  homeDir?: string;
  pathEnv?: string;
}

interface Candidate {
  path: string;
  source: RuntimeSource;
}

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export class KimiRuntimeProvider implements CliRuntimeProvider {
  readonly id = 'kimi' as const;

  constructor(private readonly options: KimiRuntimeProviderOptions) {}

  async inspectInstalled(): Promise<InstalledRuntime[]> {
    const candidates: Candidate[] = [];
    const override = this.options.overridePath?.trim();
    if (override) {
      if (!isAbsolute(override)) {
        throw new Error('KIMI_BIN must be an absolute path.');
      }
      candidates.push({ path: override, source: 'override' });
    } else {
      candidates.push({
        path: join(this.options.dataDir, 'runtimes', 'kimi', 'current', 'bin', 'kimi'),
        source: 'managed',
      });
      candidates.push({
        path: join(this.options.homeDir ?? homedir(), '.kimi-code', 'bin', 'kimi'),
        source: 'official-user',
      });
      for (const dir of (this.options.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
        if (dir.trim()) candidates.push({ path: resolve(dir, 'kimi'), source: 'path' });
      }
    }

    const seen = new Set<string>();
    const installed: InstalledRuntime[] = [];
    for (const candidate of candidates) {
      try {
        await access(candidate.path, constants.X_OK);
        const binaryPath = await realpath(candidate.path);
        if (!isAbsolute(binaryPath) || seen.has(binaryPath)) continue;
        seen.add(binaryPath);
        installed.push({ cli: this.id, binaryPath, source: candidate.source });
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

  async probe(runtime: InstalledRuntime): Promise<RuntimeProbe> {
    if (!isAbsolute(runtime.binaryPath)) {
      throw new Error('resolved Kimi binary path is not absolute');
    }
    await access(runtime.binaryPath, constants.X_OK);
    const result = await execFileAsync(runtime.binaryPath, ['--version'], {
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...this.managedEnv(),
      },
    });
    const version = firstVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      throw new Error('`kimi --version` did not report a semantic version');
    }
    return {
      cli: this.id,
      binaryPath: runtime.binaryPath,
      version,
      source: runtime.source,
    };
  }

  managedEnv(): Readonly<Record<string, string>> {
    return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
  }
}
