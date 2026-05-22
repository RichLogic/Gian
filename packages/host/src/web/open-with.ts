import { execFile } from 'node:child_process';
import type { ExternalEditor } from '@gian/shared';

export interface OpenCommand {
  command: string;
  argv: string[];
}

const PATH_TOKEN = '{path}';

/** Build the argv to launch a configured editor against an absolute path.
 *  Whole-token equal-to or substring containing "{path}" is replaced with
 *  `absPath`. If no token matches, `absPath` is appended at the end. */
export function buildEditorArgs(editor: ExternalEditor, absPath: string): OpenCommand {
  let substituted = false;
  const argv = editor.args.map(a => {
    if (a.includes(PATH_TOKEN)) {
      substituted = true;
      return a.split(PATH_TOKEN).join(absPath);
    }
    return a;
  });
  if (!substituted) argv.push(absPath);
  return { command: editor.command, argv };
}

/** Argv for the platform default opener. */
export function defaultOpenerArgs(platform: NodeJS.Platform, absPath: string): OpenCommand {
  if (platform === 'darwin') return { command: 'open', argv: [absPath] };
  if (platform === 'linux') return { command: 'xdg-open', argv: [absPath] };
  if (platform === 'win32') {
    // `start` is a cmd builtin. The empty "" is the (ignored) window title;
    // without it, start treats the first quoted argument as the title.
    return { command: 'cmd', argv: ['/c', 'start', '', absPath] };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** Spawn the given command detached and unref so it outlives the HTTP
 *  request. Errors are surfaced via the callback so the route can return
 *  a 500. Times out after 5s if the launcher itself hangs (rare). */
export function runOpen(
  cmd: OpenCommand,
  onError: (err: Error) => void,
): void {
  try {
    const child = execFile(cmd.command, cmd.argv, {
      timeout: 5000,
      windowsHide: true,
      detached: true,
    } as Parameters<typeof execFile>[2], err => {
      if (err) onError(err);
    });
    child.unref();
  } catch (err) {
    onError(err as Error);
  }
}
