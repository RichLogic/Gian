import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { loadConfig } from '../../storage/config.js';
import type { Db } from '../../storage/db.js';
import { resolveDataDir } from '../../storage/paths.js';
import { resolveWithinWorkspace } from '../../workspace/safe-path.js';
import {
  appOpenerArgs,
  buildEditorArgs,
  defaultOpenerArgs,
  revealArgs,
  runOpen,
  terminalArgs,
  type OpenCommand,
} from '../open-with.js';

export interface WorkingTreeTarget {
  path: string;
  workspace_id: string;
  session_id: string | null;
}

type ResolveWorkingTree = (id: string) => WorkingTreeTarget | null;

export function registerApplicationRoutes(
  app: Hono,
  db: Db,
  resolveWorkingTree: ResolveWorkingTree,
): void {
  // Installed applications for the Sheet's "Open with…" menu. macOS-only:
  // scans the standard .app bundle locations (LaunchServices isn't reachable
  // from Node without a native binding, and a directory scan is good enough —
  // it lists apps, the user picks one, `open -a` resolves it). Non-mac
  // platforms return an empty list so the menu degrades to default + editors.
  app.get('/api/apps', async c => {
    if (process.platform !== 'darwin') return c.json({ apps: [] });
    const home = process.env.HOME;
    const dirs = [
      '/Applications',
      '/Applications/Utilities',
      '/System/Applications',
      '/System/Applications/Utilities',
      ...(home ? [`${home}/Applications`] : []),
    ];
    const names = new Set<string>();
    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          // Skip hidden bundles like `.MTEDR` / `.SafeNetworking` — noise in a
          // user-facing "Open with…" menu.
          if (e.name.endsWith('.app') && !e.name.startsWith('.')) {
            names.add(e.name.slice(0, -4));
          }
        }
      } catch {
        // dir missing on this machine — skip
      }
    }
    return c.json({ apps: Array.from(names).sort((a, b) => a.localeCompare(b)) });
  });

  // Serve a PNG of a macOS app's icon for the "Open with…" menu + Settings.
  // macOS-only. The app's `.icns` is converted once with `sips` and cached
  // under <dataDir>/app-icons/<name>.png. Any failure (weird bundle, missing
  // icon, sips error) degrades to 404 so the web side falls back to a glyph —
  // this route must never 500 on a malformed app bundle.
  app.get('/api/apps/icon', c => {
    if (process.platform !== 'darwin') return c.json({ error: 'macOS only' }, 404);
    try {
      const name = c.req.query('name');
      if (!name) return c.json({ error: 'name required' }, 400);
      // It's a display name like "Visual Studio Code" — reject anything that
      // could escape the app dirs or the cache dir.
      if (name.includes('/') || name.includes('..') || name.includes('\0')) {
        return c.json({ error: 'invalid name' }, 400);
      }

      const cacheDir = join(resolveDataDir(), 'app-icons');
      mkdirSync(cacheDir, { recursive: true });
      const cacheFile = join(cacheDir, `${name}.png`);
      // Defence in depth: the resolved cache path must stay inside cacheDir.
      if (resolve(cacheFile) !== resolve(cacheDir, `${name}.png`) ||
          !resolve(cacheFile).startsWith(resolve(cacheDir) + sep)) {
        return c.json({ error: 'invalid name' }, 400);
      }

      if (existsSync(cacheFile)) {
        const bytes = readFileSync(cacheFile);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      // Locate <dir>/<name>.app across the same dirs GET /api/apps scans.
      const home = process.env.HOME;
      const dirs = [
        '/Applications',
        '/Applications/Utilities',
        '/System/Applications',
        '/System/Applications/Utilities',
        // Finder lives here (not a normal /Applications app) — needed so the
        // "Reveal in Finder" menu item can show the Finder icon.
        '/System/Library/CoreServices',
        ...(home ? [`${home}/Applications`] : []),
      ];
      let appPath: string | null = null;
      for (const dir of dirs) {
        const candidate = join(dir, `${name}.app`);
        if (existsSync(candidate)) {
          appPath = candidate;
          break;
        }
      }
      if (!appPath) return c.json({ error: 'app not found' }, 404);

      // Resolve the .icns: prefer the bundle's declared CFBundleIconFile,
      // fall back to the first *.icns in Contents/Resources.
      const resourcesDir = join(appPath, 'Contents/Resources');
      let icnsPath: string | null = null;
      try {
        let icon = execFileSync(
          'defaults',
          ['read', join(appPath, 'Contents/Info'), 'CFBundleIconFile'],
          { encoding: 'utf8' },
        ).trim();
        if (icon && !icon.endsWith('.icns')) icon = `${icon}.icns`;
        if (icon) {
          const declared = join(resourcesDir, icon);
          if (existsSync(declared)) icnsPath = declared;
        }
      } catch {
        // `defaults` failed (no key / bad plist) — fall through to readdir.
      }
      if (!icnsPath) {
        try {
          const first = readdirSync(resourcesDir).find(f => f.endsWith('.icns'));
          if (first) icnsPath = join(resourcesDir, first);
        } catch {
          // Resources dir missing/unreadable — no icon.
        }
      }
      if (!icnsPath) return c.json({ error: 'icon not found' }, 404);

      // Convert to a 64px PNG into the cache. sips throwing → 404.
      try {
        execFileSync(
          'sips',
          ['-s', 'format', 'png', '-Z', '64', icnsPath, '--out', cacheFile],
          { stdio: 'ignore', timeout: 5000 },
        );
      } catch {
        return c.json({ error: 'convert failed' }, 404);
      }

      if (!existsSync(cacheFile)) return c.json({ error: 'convert failed' }, 404);
      const bytes = readFileSync(cacheFile);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch {
      // Anything unexpected (weird bundle, fs error) → 404, never 500.
      return c.json({ error: 'icon unavailable' }, 404);
    }
  });

  // Reveal a working tree (main tree or worktree) in macOS Finder.
  // :id accepts `ws:<workspace-id>` or `wt:<session-id>`, same shape used by
  // the rest of the /api/working_trees/:id endpoints.
  app.post('/api/working_trees/:id/reveal', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    try {
      execFileSync('open', [wt.path], { timeout: 5000, stdio: 'ignore' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Stage a single path into the index (`git add -- <path>`). Works for both
  // tracked modifications and brand-new untracked files. Index-only — never
  // touches working-tree contents. Path is bounded to the working tree the
  // same way /raw and /open are.
  app.post('/api/working_trees/:id/stage', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let body: { path?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }
    const absPath = await resolveWithinWorkspace(wt.path, body.path);
    if (!absPath) {
      return c.json({ error: 'path escapes working tree' }, 400);
    }

    try {
      execFileSync('git', ['-C', wt.path, 'add', '--', body.path], {
        timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Unstage a single path from the index (`git reset -q HEAD -- <path>`).
  // Index-only — leaves the working-tree contents untouched, so it's the
  // pure inverse of /stage. Same path-boundary check.
  app.post('/api/working_trees/:id/unstage', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let body: { path?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }
    const absPath = await resolveWithinWorkspace(wt.path, body.path);
    if (!absPath) {
      return c.json({ error: 'path escapes working tree' }, 400);
    }

    try {
      execFileSync('git', ['-C', wt.path, 'reset', '-q', 'HEAD', '--', body.path], {
        timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Open a file via the system default opener or a configured external
  // editor. Path resolution mirrors /raw and /reveal — id must be a known
  // ws:/wt: handle and the relative path is bounded to the working tree.
  app.post('/api/working_trees/:id/open', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let body: { path?: string; editor_id?: string; app?: string; builtin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }

    const absPath = await resolveWithinWorkspace(wt.path, body.path);
    if (!absPath) {
      return c.json({ error: 'path escapes working tree' }, 400);
    }

    try {
      statSync(absPath);
    } catch {
      return c.json({ error: 'file not found' }, 404);
    }

    let cmd: OpenCommand;
    if (body.editor_id) {
      const cfg = loadConfig(db);
      const editor = cfg.external_editors.find(e => e.id === body.editor_id);
      if (!editor) return c.json({ error: 'editor not found' }, 404);
      cmd = buildEditorArgs(editor, absPath);
    } else if (body.app) {
      // "Open with…" → a named macOS application (LaunchServices). The app
      // list itself comes from GET /api/apps, so this is macOS-only.
      if (process.platform !== 'darwin') {
        return c.json({ error: 'open-with-app is macOS only' }, 400);
      }
      cmd = appOpenerArgs(body.app, absPath);
    } else if (body.builtin) {
      // Fixed system openers from the "Open with…" menu. `default` works on
      // every platform; `finder` (reveal) and `terminal` (open Terminal at the
      // file's folder) are macOS-only. ('browser' is handled client-side.)
      if (body.builtin === 'default') {
        let defaultCmd: OpenCommand;
        try {
          defaultCmd = defaultOpenerArgs(process.platform, absPath);
        } catch (err) {
          return c.json({ error: String((err as Error).message) }, 500);
        }
        // Default opener is the one place where "no handler" is a real, common
        // outcome the web wants to fall back on. On macOS, `open <file>` exits
        // non-zero ("No application knows how to open …") when nothing claims
        // the type — so run it AWAITED here and report 422 on failure instead of
        // returning a fire-and-forget 200. Other platforms keep the existing
        // detached runOpen path below.
        if (process.platform === 'darwin') {
          try {
            execFileSync(defaultCmd.command, defaultCmd.argv, {
              stdio: 'ignore',
              timeout: 5000,
            });
          } catch {
            return c.json({ error: 'no-app' }, 422);
          }
          return c.json({ ok: true });
        }
        cmd = defaultCmd;
      } else if (process.platform !== 'darwin') {
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
        cmd = defaultOpenerArgs(process.platform, absPath);
      } catch (err) {
        return c.json({ error: String((err as Error).message) }, 500);
      }
    }

    return new Promise<Response>(resolve => {
      const timer = setTimeout(
        () => resolve(c.json({ ok: true }) as unknown as Response),
        50,
      );
      runOpen(cmd, err => {
        clearTimeout(timer);
        resolve(c.json({ error: String(err.message) }, 500) as unknown as Response);
      });
    });
  });
}

