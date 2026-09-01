/**
 * ZCode runtime provider (Revision 2 §4.1): ZCode ships only inside the
 * ZCode.app bundle — Gian never downloads, installs, mirrors, or upgrades it.
 * Discovery order: agents.json cliPath override (`ZCODE_BIN`), then the
 * system and user application bundles. The CLI entry is a Node bundle with a
 * `#!/usr/bin/env node` shebang, so it probes directly with `--version`.
 *
 * Readiness extras frozen by WP0 G1: a missing `~/.zcode/cli/config.json`
 * makes the runtime `invalid` with a repairable, generic readiness issue —
 * the user must configure an explicit CLI model provider themselves; Gian
 * never creates or modifies anything under `~/.zcode`. (WP0 evidence covers
 * only the missing-config failure path; it does NOT establish that any
 * particular login command regenerates the file, so the guidance names the
 * file and the required fact, not an unverified repair command.)
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runProtectedCommand } from './protected-command.js';
import { runtimeContentSnapshot } from './content-snapshot.js';
import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeProcessGroupProtector,
} from './types.js';

/** Generic readiness issue surfaced on Agent status (Revision 2 §13.2):
 *  shared shape, ZCode-agnostic wording, never a new executor enum. */
export const ZCODE_CLI_CONFIG_READINESS_ISSUE = {
  code: 'zcode_cli_config_missing',
  message: 'ZCode CLI model configuration is missing at ~/.zcode/cli/config.json. '
    + 'Configure an explicit model provider for ZCode CLI, then retry. '
    + 'Gian will not create or modify this file.',
  repairable: true,
} as const;

export interface ZcodeRuntimeProviderOptions {
  overridePath?: string;
  pathEnv?: string;
  /** HOME override (test seam). */
  home?: string;
}

interface Candidate {
  path: string;
  source: 'override' | 'official-user' | 'official-system';
}

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export class ZcodeRuntimeProvider implements CliRuntimeProvider {
  readonly id = 'zcode' as const;

  constructor(private readonly options: ZcodeRuntimeProviderOptions = {}) {}

  private home(): string {
    return this.options.home ?? homedir();
  }

  async inspectInstalled(overridePath?: string): Promise<InstalledRuntime[]> {
    const candidates: Candidate[] = [];
    const override = (overridePath ?? this.options.overridePath)?.trim();
    if (override) {
      if (!isAbsolute(override)) {
        throw new Error('ZCODE_BIN must be an absolute path.');
      }
      candidates.push({ path: override, source: 'override' });
    } else {
      candidates.push({
        path: join(this.home(), 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
        source: 'official-user',
      });
      candidates.push({
        path: join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
        source: 'official-system',
      });
    }

    const seen = new Set<string>();
    const installed: InstalledRuntime[] = [];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate.path);
        if (!info.isFile()) continue;
        await access(candidate.path, constants.X_OK);
        if (seen.has(candidate.path)) continue;
        seen.add(candidate.path);
        installed.push({ cli: this.id, binaryPath: candidate.path, source: candidate.source });
      } catch {
        // Keep going: bundle candidates are optional by design.
      }
    }
    return installed;
  }

  async probe(
    runtime: InstalledRuntime,
    protector?: RuntimeProcessGroupProtector,
  ): Promise<RuntimeProbe> {
    if (!isAbsolute(runtime.binaryPath)) {
      throw new Error('resolved ZCode entry path is not absolute');
    }
    await access(runtime.binaryPath, constants.X_OK);
    const result = await runProtectedCommand({
      command: runtime.binaryPath,
      args: ['--version'],
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...this.managedEnv(),
      },
      label: 'zcode --version',
      ...(protector ? { protector } : {}),
    });
    const version = firstVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      throw new Error('`zcode --version` did not report a semantic version');
    }
    return {
      cli: this.id,
      binaryPath: runtime.binaryPath,
      version,
      source: runtime.source,
    };
  }

  managedEnv(): Readonly<Record<string, string>> {
    return {};
  }

  snapshot(runtime: InstalledRuntime | RuntimeProbe): Promise<string> {
    return runtimeContentSnapshot(runtime.binaryPath);
  }

  /** WP0 G1: the CLI refuses to run sessions without its model-provider
   *  config. This check is read-only and never writes `~/.zcode`. */
  async configReady(): Promise<boolean> {
    try {
      await access(join(this.home(), '.zcode', 'cli', 'config.json'), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
