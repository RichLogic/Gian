import { execFile } from 'node:child_process';
import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LegacyHostRetirementOptions {
  platform?: NodeJS.Platform;
  homeDir: string;
  uid?: number;
  bootout?: (label: string, plistPath: string) => Promise<void>;
}

export interface LegacyHostRetirementResult {
  retired: boolean;
  sourcePath: string;
  retiredPath: string;
}

/** Retire the pre-Desktop LaunchAgent before the packaged Host can bind its
 * production resources. Keeping the plist under a non-.plist suffix leaves a
 * local recovery artifact without letting launchd reload it at next login. */
export async function retireLegacyHostLaunchAgent(
  options: LegacyHostRetirementOptions,
): Promise<LegacyHostRetirementResult> {
  const sourcePath = join(options.homeDir, 'Library', 'LaunchAgents', 'com.gian.host.plist');
  const retiredPath = `${sourcePath}.retired-by-desktop`;
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { retired: false, sourcePath, retiredPath };
  }
  try {
    await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { retired: false, sourcePath, retiredPath };
    }
    throw error;
  }

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('Cannot retire legacy Gian LaunchAgent without a user id.');
  const bootout = options.bootout ?? (async (label, plistPath) => {
    try {
      await execFileAsync('launchctl', ['bootout', label, plistPath]);
    } catch {
      // launchctl reports a non-zero status when the plist is already
      // unloaded. Renaming it is still the required persistent retirement.
    }
  });
  await bootout(`gui/${uid}`, sourcePath);
  await rename(sourcePath, retiredPath);
  return { retired: true, sourcePath, retiredPath };
}
