#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeRun,
  inspectEventStorageV3,
  migrateEventStorageV3,
  rollbackEventStorageV3,
  vacuumEventStorageV3,
  verifyEventStorageV3,
} from '../storage/event-storage-v3-migrator.js';

const HELP = `Gian event-storage v3 offline migration

Usage:
  event-storage-v3 inspect  --db <path> --report <path>
  event-storage-v3 migrate  --db <path> --backup-dir <dir> --confirm <token>
  event-storage-v3 migrate  --db <path> --backup-dir <dir> --resume <run-id>
  event-storage-v3 verify   --db <path> --run <run-dir>
  event-storage-v3 rollback --db <path> --run <run-dir>
  event-storage-v3 vacuum   --db <path> --run <run-dir>

Safety:
  Quit Gian before every command. Migrate always creates and verifies its own
  backup. Vacuum is a separate post-App-validation command. Backups are never
  deleted automatically.
`;

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = args[0];
  const flags = parseFlags(args.slice(1));
  const databasePath = required(flags, 'db');
  const releaseVersion = packagedReleaseVersion();

  if (command === 'inspect') {
    const reportPath = required(flags, 'report');
    const report = await inspectEventStorageV3({ databasePath, reportPath, releaseVersion });
    process.stdout.write(`${JSON.stringify({
      command,
      databasePath: report.databasePath,
      releaseVersion,
      databaseBytes: report.databaseBytes,
      sessions: report.counts.sessions,
      turns: report.counts.turns,
      events: report.counts.events,
      snapshotRowsRemovable: report.compactionEstimate.snapshotRowsRemovable,
      streamRowsRemovable: report.compactionEstimate.streamRowsRemovable,
      reportPath: resolve(reportPath),
      confirmationToken: report.confirmationToken,
    }, null, 2)}\n`);
    return 0;
  }

  if (command === 'migrate') {
    const manifest = await migrateEventStorageV3({
      databasePath,
      backupDirectory: required(flags, 'backup-dir'),
      releaseVersion,
      confirmationToken: flags.confirm,
      resumeRunId: flags.resume,
    });
    process.stdout.write(`${JSON.stringify({
      command,
      run: describeRun(manifest),
      runDirectory: manifest.runDirectory,
      backupPath: manifest.backupPath,
      state: 'active',
      next: 'Open Gian and validate representative histories before running vacuum.',
    }, null, 2)}\n`);
    return 0;
  }

  if (command === 'verify') {
    const report = await verifyEventStorageV3({
      databasePath,
      runDirectory: required(flags, 'run'),
      releaseVersion,
    });
    process.stdout.write(`${JSON.stringify({ command, ...report }, null, 2)}\n`);
    return 0;
  }

  if (command === 'rollback') {
    const failedPath = await rollbackEventStorageV3({
      databasePath,
      runDirectory: required(flags, 'run'),
      releaseVersion,
    });
    process.stdout.write(`${JSON.stringify({
      command,
      state: 'legacy-restored',
      failedMigratedDatabase: failedPath,
    }, null, 2)}\n`);
    return 0;
  }

  if (command === 'vacuum') {
    const result = await vacuumEventStorageV3({
      databasePath,
      runDirectory: required(flags, 'run'),
      releaseVersion,
    });
    process.stdout.write(`${JSON.stringify({ command, ...result }, null, 2)}\n`);
    return 0;
  }

  throw new Error(`unknown command ${String(command)}\n\n${HELP}`);
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option near ${flag ?? '<end>'}`);
    }
    const name = flag.slice(2);
    if (flags[name] !== undefined) throw new Error(`duplicate option --${name}`);
    flags[name] = value;
  }
  return flags;
}

function required(flags: Record<string, string | undefined>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`missing required option --${name}`);
  return value;
}

function packagedReleaseVersion(): string {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error(`cannot read packaged release version from ${packagePath}`);
  }
  return parsed.version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[event-storage-v3] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
