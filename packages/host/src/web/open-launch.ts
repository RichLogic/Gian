import type { Context } from 'hono';
import { dirname } from 'node:path';
import { loadConfig } from '../storage/config.js';
import type { Db } from '../storage/db.js';
import {
  appOpenerArgs,
  buildEditorArgs,
  defaultOpenerArgs,
  revealArgs,
  runOpen,
  terminalArgs,
  type OpenCommand,
} from './open-with.js';

export interface OpenLaunchBody {
  editor_id?: string;
  app?: string;
  builtin?: string;
}

export interface OpenLaunchSeams {
  platform: NodeJS.Platform;
  db: Db;
  runOpenSync: (command: OpenCommand) => void;
  runOpenDetached: typeof runOpen;
}

/** Shared editor / app / builtin launcher used by working-tree `/open` and
 *  the attachments-only `/api/files/open` channel. The caller has already
 *  resolved and existence-checked `absPath`. */
export function respondResolvedOpen(
  c: Context,
  absPath: string,
  body: OpenLaunchBody,
  seams: OpenLaunchSeams,
): Response | Promise<Response> {
  const { platform, db, runOpenSync, runOpenDetached } = seams;
  let cmd: OpenCommand;
  if (body.editor_id) {
    const cfg = loadConfig(db);
    const editor = cfg.external_editors.find(e => e.id === body.editor_id);
    if (!editor) return c.json({ error: 'editor not found' }, 404);
    cmd = buildEditorArgs(editor, absPath);
  } else if (body.app) {
    if (platform !== 'darwin') {
      return c.json({ error: 'open-with-app is macOS only' }, 400);
    }
    cmd = appOpenerArgs(body.app, absPath);
  } else if (body.builtin) {
    if (body.builtin === 'default') {
      let defaultCmd: OpenCommand;
      try {
        defaultCmd = defaultOpenerArgs(platform, absPath);
      } catch (err) {
        return c.json({ error: String((err as Error).message) }, 500);
      }
      if (platform === 'darwin') {
        try {
          runOpenSync(defaultCmd);
        } catch {
          return c.json({ error: 'no-app' }, 422);
        }
        return c.json({ ok: true });
      }
      cmd = defaultCmd;
    } else if (platform !== 'darwin') {
      return c.json({ error: 'this opener is macOS only' }, 400);
    } else if (body.builtin === 'finder') {
      cmd = revealArgs(absPath);
    } else if (body.builtin === 'terminal') {
      cmd = terminalArgs(dirname(absPath));
    } else {
      return c.json({ error: 'unknown builtin opener' }, 400);
    }
  } else {
    try {
      cmd = defaultOpenerArgs(platform, absPath);
    } catch (err) {
      return c.json({ error: String((err as Error).message) }, 500);
    }
  }

  return new Promise<Response>(resolve => {
    const timer = setTimeout(
      () => resolve(c.json({ ok: true }) as unknown as Response),
      50,
    );
    runOpenDetached(cmd, err => {
      clearTimeout(timer);
      resolve(c.json({ error: String(err.message) }, 500) as unknown as Response);
    });
  });
}
