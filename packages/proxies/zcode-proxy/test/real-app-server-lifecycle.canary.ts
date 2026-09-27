/**
 * EXPLICIT CANARY (platform compatibility) — NOT part of the default
 * deterministic suite. Run it via `pnpm --filter @gian/zcode-proxy
 * test:real-app-server` (or scripts/run-zcode-app-server-canary.mjs).
 *
 * The code-generated synthetic config (see
 * test/fixtures/synthetic-zcode-config.mjs) must be accepted by the REAL
 * local ZCode app-server — `session/create` then `session/read` succeed with
 * a fresh mkdtemp HOME and workspace.
 *
 * Since the 0.16.9 open-source baseline (github.com/zai-org/ZCode @
 * 328c1a0c), the standalone runtime requires the built-in provider config at
 * `<entry>/provider/zcode-builtin.json`
 * (packages/cli/src/provider-runtime-env.ts:150). The installed ZCode.app
 * bundle does not ship that file and must never be modified, so with only
 * the app bundle present this canary SKIPS with an explicit unavailable
 * note — an honest "not executed", never a fake PASS. Point ZCODE_CJS at a
 * standalone runtime (e.g. the managed-runtime build) to execute it.
 *
 * Hard guarantees enforced by this test:
 *  - NO session/send (never any model/provider traffic, no quota);
 *  - no user data: the HOME/workspace are throwaway mkdtemp dirs; the user's
 *    real ~/.zcode is never read or written;
 *  - the app-server child is always stopped and temp dirs removed.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  INNER_PROTOCOL_NAME,
  INNER_PROTOCOL_VERSION,
} from '../src/identity.js';
import {
  registerGianReverseHandlers,
  ZCodeTransport,
} from '../src/inner/transport.js';

const DEFAULT_ZCODE_CJS = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

test('real app-server accepts the synthetic config: session/create then session/read', async (t) => {
  const runtimeBin = process.env.ZCODE_CJS ?? DEFAULT_ZCODE_CJS;
  if (!existsSync(runtimeBin)) {
    t.skip(
      `real ZCode app-server unavailable (no ${runtimeBin}); `
      + 'synthetic-config lifecycle regression NOT executed — report unavailable, not a pass',
    );
    return;
  }
  // The standalone 0.16.9 runtime needs its built-in provider config next to
  // the entry; the installed app bundle neither ships it nor may be modified.
  if (!existsSync(join(runtimeBin, '..', 'provider', 'zcode-builtin.json'))) {
    t.skip(
      `${runtimeBin} cannot start standalone: provider/zcode-builtin.json is missing `
      + 'and the app bundle is never modified (provider-runtime-env.ts:150). '
      + 'synthetic-config lifecycle regression NOT executed — report unavailable, not a pass. '
      + 'Point ZCODE_CJS at a standalone runtime build to execute this canary.',
    );
    return;
  }

  const { buildSyntheticZcodeConfig, SYNTHETIC_MODEL_REF } = await import(
    pathToFileURL(resolve('test/fixtures/synthetic-zcode-config.mjs')).href
  );

  // NOTE: keep the throwaway dirs on the SHORT /tmp path — the app-server
  // binds a unix socket under its HOME, and macOS's long default temp dir
  // (~90 chars) overflows sun_path (listen EINVAL). POSIX /tmp is the
  // portable short choice for the platforms ZCode supports.
  const home = mkdtempSync('/tmp/zcode-real-home-');
  const workspace = mkdtempSync('/tmp/zcode-real-ws-');
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // Synthetic config, generated entirely by code, written into the throwaway
  // HOME only. The user's real ~/.zcode is never touched.
  mkdirSync(join(home, '.zcode/cli'), { recursive: true });
  writeFileSync(
    join(home, '.zcode/cli/config.json'),
    JSON.stringify(buildSyntheticZcodeConfig(), null, 2),
    { mode: 0o600 },
  );
  // Guard against accidental reliance on the developer's real config: the
  // config we just wrote must contain the synthetic ref and nothing real.
  const written = JSON.parse(
    readFileSync(join(home, '.zcode/cli/config.json'), 'utf8'),
  ) as { model: { main: string } };
  assert.equal(written.model.main, SYNTHETIC_MODEL_REF);

  const childTmp = join(home, 'tmp');
  mkdirSync(childTmp, { recursive: true });
  const transport = new ZCodeTransport({
    runtimeBin,
    cwd: workspace,
    env: {
      home,
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      tmpdir: childTmp,
      lang: 'en_US.UTF-8',
    },
  });
  t.after(() => transport.stop());
  const stderrLines: string[] = [];
  transport.on('stderr', (line) => stderrLines.push(String(line)));
  registerGianReverseHandlers(transport);
  transport.start();

  // 1. session/create must succeed against the synthetic config.
  const withStderr = (error: unknown): unknown => {
    if (stderrLines.length > 0 && error instanceof Error) {
      return new Error(`${error.message} | app-server stderr: ${stderrLines.slice(-4).join(' / ')}`);
    }
    return error;
  };
  const created = await transport.request('session/create', {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
  }, 60_000).catch((error: unknown) => {
    throw withStderr(error);
  }) as {
    session?: { sessionId?: string; status?: string };
    protocol?: { name?: string; version?: number };
  } | null;
  assert.ok(created, 'session/create returned a result');
  const sessionId = created.session?.sessionId;
  assert.ok(
    typeof sessionId === 'string' && sessionId.startsWith('sess_'),
    `session/create returned a native session id (got ${String(sessionId)})`,
  );
  assert.equal(created.protocol?.name, INNER_PROTOCOL_NAME);
  assert.equal(created.protocol?.version, INNER_PROTOCOL_VERSION);

  // 2. session/read must succeed for the created session.
  const read = await transport.request('session/read', {
    sessionId,
  }, 30_000).catch((error: unknown) => {
    throw withStderr(error);
  }) as {
    session?: { sessionId?: string; status?: string };
  } | null;
  assert.ok(read, 'session/read returned a result');
  assert.equal(read.session?.sessionId, sessionId);
  assert.equal(read.session?.status, 'idle');

  // 3. Deliberately NO session/send anywhere in this test: the synthetic
  // provider endpoint (127.0.0.1:9) is unreachable, and the lifecycle under
  // test never issues a model request.
  void stderrLines; // surfaced on failure below
});
