import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AntigravityRuntimeError } from '../src/runtime/errors.js';
import {
  ANTIGRAVITY_CLI_MODELS_ARGS,
  ANTIGRAVITY_CLI_MODELS_MAX_COUNT,
  ANTIGRAVITY_CLI_MODELS_TIMEOUT_MS,
  AntigravityCliModels,
  AntigravityCliModelsError,
  antigravityCliHelperCandidates,
  listAntigravityCliModels,
  reapOwnedGroup,
  type AntigravityCliModelsCleanupDiagnostic,
  type AntigravityCliModelsFailure,
  type AntigravityCliModelsOptions,
} from '../src/runtime/cli-models.js';

const SECRET = 'super-secret-value';
const SECRET_URL = 'https://evil.example/oauth?code=super-secret-value';
const HOME_MESSAGE = 'Antigravity CLI model query requires the default Gemini home.';
const UNEXPECTED = 'Antigravity CLI model query returned an unexpected response.';
const skipWindows = { skip: process.platform === 'win32' };

interface CliReport {
  argv: string[];
  cwd: string;
  pwd: string | null;
  stdinBytes: number;
  geminiHome: string | null;
  gianAgentHome: string | null;
  home: string | null;
  harness: boolean;
  hasToken: boolean;
  marker: string | null;
}

interface FixturePaths {
  root: string;
  home: string;
  cwd: string;
  helper: string;
  report: string;
  pidPath: string;
}

function sourceFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  const testDir = basename(here) === 'test' && basename(parent) === 'dist'
    ? join(parent, '..', 'test')
    : here;
  return join(testDir, 'fixtures', 'fake-antigravity-cli-models.mjs');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function installFake(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(sourceFixturePath())} "$@"\n`;
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function makePaths(): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-models-'));
  const home = join(root, 'os-user');
  const cwd = join(root, 'cwd');
  const helper = join(root, 'fake', 'agy');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await installFake(helper);
  return {
    root,
    home,
    cwd,
    helper,
    report: join(root, 'report.json'),
    pidPath: join(root, 'leader.pid'),
  };
}

function isolatedOptions(
  paths: FixturePaths,
  env: NodeJS.ProcessEnv,
  bounds: AntigravityCliModelsOptions = {},
): AntigravityCliModelsOptions {
  const options = queryOptions(paths, env, bounds);
  delete options.cwd;
  return options;
}

function queryOptions(
  paths: FixturePaths,
  env: NodeJS.ProcessEnv,
  bounds: AntigravityCliModelsOptions = {},
): AntigravityCliModelsOptions {
  return {
    ...bounds,
    osUserHome: paths.home,
    cwd: paths.cwd,
    candidates: bounds.candidates ?? [paths.helper],
    env: {
      HOME: paths.home,
      PATH: '/usr/bin:/bin',
      FAKE_AGY_CLI_REPORT: paths.report,
      FAKE_AGY_CLI_PID: paths.pidPath,
      ...env,
    },
  };
}

function modelsDocument(models: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'SUCCESS',
    conversation_id: '',
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...extra,
    command: {
      name: 'models',
      data: { models },
    },
  });
}

async function readReport(path: string): Promise<CliReport> {
  const value = JSON.parse(await readFile(path, 'utf8')) as CliReport;
  assert.ok(Array.isArray(value.argv));
  return value;
}

async function assertAbsent(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
}

function assertFailure(
  error: unknown,
  failure: AntigravityCliModelsFailure,
  message: string,
  domainCode: string,
): asserts error is AntigravityCliModelsError {
  assert.ok(error instanceof AntigravityCliModelsError);
  assert.equal(error.failure, failure);
  assert.equal(error.domainCode, domainCode);
  assert.equal(error.retryable, false);
  assert.equal(error.message, message);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes(SECRET), false);
  assert.equal(error.message.includes('https://'), false);
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const value of Object.values(current)) {
      if (typeof value === 'string') {
        assert.equal(value.includes(SECRET), false);
        assert.equal(value.includes('https://'), false);
      } else if (value !== null && typeof value === 'object') pending.push(value);
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

async function waitForText(path: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() - started > 2_000) throw new Error('timed out waiting for the fake CLI report');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test('production helper discovery is the user install, Homebrew, then /usr/local', () => {
  assert.deepEqual(antigravityCliHelperCandidates('/Users/owner'), [
    { path: '/Users/owner/.local/bin/agy', source: 'official-user' },
    { path: '/opt/homebrew/bin/agy', source: 'official-system' },
    { path: '/usr/local/bin/agy', source: 'official-system' },
  ]);
  assert.deepEqual([...ANTIGRAVITY_CLI_MODELS_ARGS], ['--output-format', 'json', 'models']);
  assert.equal(ANTIGRAVITY_CLI_MODELS_TIMEOUT_MS, 60_000);
  assert.throws(
    () => antigravityCliHelperCandidates('relative'),
    (error: unknown) => error instanceof AntigravityRuntimeError
      && error.message === 'Antigravity CLI model query options are invalid.',
  );
  assert.throws(
    () => new AntigravityCliModels({ osUserHome: '/Users/owner', timeoutMs: 0 }),
    (error: unknown) => error instanceof AntigravityRuntimeError
      && error.message === 'Antigravity CLI model query options are invalid.',
  );
});

test('returns validated Gemini id and label options and the resolved helper', async () => {
  const paths = await makePaths();
  const secretPath = join(paths.home, '.gemini', 'oauth_creds.json');
  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, SECRET);
  const catalog = new AntigravityCliModels(queryOptions(paths, {
    PWD: '/workspace/secret-checkout',
    AGY_TOKEN: SECRET,
    FAKE_AGY_CLI_MARKER: 'models-query',
    FAKE_AGY_CLI_STDERR: SECRET_URL,
    FAKE_AGY_CLI_STDOUT: modelsDocument([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', default: true },
    ], { ignored_prompt: 'do not send' }),
  }));
  try {
    const first = await catalog.list();
    const second = await catalog.list();
    const report = await readReport(paths.report);
    const info = await stat(first.helper.path);
    assert.deepEqual(first.models, [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    ]);
    assert.deepEqual(second.models, first.models);
    assert.deepEqual(Object.keys(first.models[0] ?? {}), ['id', 'label']);
    assert.equal(first.helper.path, await realpath(paths.helper));
    assert.equal(first.helper.source, 'injected');
    assert.equal(first.helper.dev, info.dev);
    assert.equal(first.helper.ino, info.ino);
    assert.equal(first.helper.size, info.size);
    assert.equal(first.helper.mtimeMs, info.mtimeMs);
    assert.deepEqual(report.argv, ['--output-format', 'json', 'models']);
    assert.equal(report.cwd, await realpath(paths.cwd));
    assert.equal(report.pwd, paths.cwd);
    assert.equal(report.stdinBytes, 0);
    assert.equal(report.geminiHome, null);
    assert.equal(report.gianAgentHome, null);
    assert.equal(report.harness, false);
    assert.equal(report.hasToken, true);
    assert.equal(report.marker, 'models-query');
    assert.equal(JSON.stringify(report).includes(SECRET), false);
    assert.equal(JSON.stringify(first).includes(SECRET), false);
    assert.equal(JSON.stringify(first).includes('https://'), false);
    assert.equal(JSON.stringify(first).includes('secret-checkout'), false);
    assert.equal(await readFile(secretPath, 'utf8'), SECRET);
    assert.deepEqual(await readdir(paths.cwd), []);
    assert.equal(processAlive(Number(await readFile(paths.pidPath, 'utf8'))), false);
  } finally {
    await catalog.stop().catch(() => undefined);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('filters legitimate non-Gemini rows and identical duplicates', async () => {
  const paths = await makePaths();
  try {
    const filtered = await listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'claude-sonnet', label: 'Claude' },
        { id: 'GEMINI-pro', label: 'Upper' },
        { id: 'gemini-ok', label: 'Gemini OK', description: SECRET_URL },
      ]),
      FAKE_AGY_CLI_STDERR: SECRET_URL,
    }));
    assert.deepEqual(filtered.models, [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-ok', label: 'Gemini OK' },
    ]);
    assert.equal(JSON.stringify(filtered).includes(SECRET), false);
    assert.equal(JSON.stringify(filtered).includes('https://'), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('malformed model rows are invalid and an empty Gemini list is unavailable', async () => {
  const paths = await makePaths();
  const malformed = [
    { id: 'gemini-3.8-flash-high', label: 'Duplicate label changes', extra: true },
    { id: '', label: 'Empty' },
    { id: 'gemini-missing-label' },
    { id: 'gemini-blank', label: '   ' },
    { id: 'gemini-url', label: `See ${SECRET_URL}` },
    { id: 'gemini://bad', label: 'Bad id' },
    { id: 'gemini-spaced id', label: 'Spaced' },
    { id: `gemini-${'x'.repeat(200)}`, label: 'Too long' },
    { id: 12, label: 'Typed' },
    { id: 'gemini-typed', label: 12 },
    'nope',
    null,
  ];
  try {
    await assert.rejects(
      listAntigravityCliModels(queryOptions(paths, {
        FAKE_AGY_CLI_STDOUT: modelsDocument([
          { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
          { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (Low)' },
        ]),
        FAKE_AGY_CLI_STDERR: SECRET_URL,
      })),
      (error: unknown) => {
        assertFailure(error, 'invalid_response', UNEXPECTED, 'RUNTIME_ERROR');
        assert.equal(error.message.includes('Low'), false);
        return true;
      },
    );
    for (const row of malformed) {
      const document = Array.isArray(row) ? row : [
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        row,
      ];
      await assert.rejects(
        listAntigravityCliModels(queryOptions(paths, {
          FAKE_AGY_CLI_STDOUT: modelsDocument(document),
          FAKE_AGY_CLI_STDERR: SECRET_URL,
        })),
        (error: unknown) => {
          assertFailure(error, 'invalid_response', UNEXPECTED, 'RUNTIME_ERROR');
          assert.equal(error.message.includes(SECRET), false);
          assert.equal(error.message.includes('gemini-3.8-flash-high'), false);
          return true;
        },
      );
    }
    for (const models of [[], [{ id: 'claude-opus', label: 'Claude' }]]) {
      await assert.rejects(
        listAntigravityCliModels(queryOptions(paths, {
          FAKE_AGY_CLI_STDOUT: modelsDocument(models),
          FAKE_AGY_CLI_STDERR: SECRET_URL,
        })),
        (error: unknown) => {
          assertFailure(
            error,
            'models_unavailable',
            'Antigravity CLI returned no Gemini models.',
            'RUNTIME_UNAVAILABLE',
          );
          assert.equal(error.message.includes('claude'), false);
          return true;
        },
      );
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('rejects malformed CLI model documents without returning their text', async () => {
  const paths = await makePaths();
  const valid = modelsDocument([{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }]);
  const samples = [
    '',
    '{',
    'not-json',
    'null',
    '{"status":"SUCCESS"}',
    `{"status":"FAILED","command":{"name":"models","data":{"models":[{"id":"gemini-a","label":"${SECRET_URL}"}]}}}`,
    '{"status":"SUCCESS","command":{"name":"prompt","data":{"models":[]}}}',
    '{"status":"SUCCESS","command":{"name":"models","data":{}}}',
    '{"status":"SUCCESS","command":{"name":"models","data":{"models":{}}}}',
    `${valid} trailing`,
    `${valid}\n${valid}`,
  ];
  try {
    for (const stdout of samples) {
      await assert.rejects(
        listAntigravityCliModels(queryOptions(paths, {
          FAKE_AGY_CLI_STDOUT: stdout,
          FAKE_AGY_CLI_STDERR: SECRET_URL,
          AGY_TOKEN: SECRET,
        })),
        (error: unknown) => {
          assertFailure(error, 'invalid_response', UNEXPECTED, 'RUNTIME_ERROR');
          assert.equal(error.message.includes('gemini'), false);
          return true;
        },
      );
    }
    const oversized = Array.from({ length: ANTIGRAVITY_CLI_MODELS_MAX_COUNT + 1 }, (_, index) => ({
      id: `gemini-${index}`,
      label: `Gemini ${index}`,
    }));
    await assert.rejects(
      listAntigravityCliModels(queryOptions(paths, {
        FAKE_AGY_CLI_STDOUT: modelsDocument(oversized),
        FAKE_AGY_CLI_STDERR: SECRET_URL,
      })),
      (error: unknown) => {
        assertFailure(error, 'invalid_response', UNEXPECTED, 'RUNTIME_ERROR');
        return true;
      },
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('treats EOF and a non-zero exit as fixed failures', async () => {
  const paths = await makePaths();
  try {
    await assert.rejects(
      listAntigravityCliModels(queryOptions(paths, {
        FAKE_AGY_CLI_STDERR: SECRET_URL,
      })),
      (error: unknown) => {
        assertFailure(error, 'invalid_response', UNEXPECTED, 'RUNTIME_ERROR');
        return true;
      },
    );
    await assert.rejects(
      listAntigravityCliModels(queryOptions(paths, {
        FAKE_AGY_CLI_EXIT: '2',
        FAKE_AGY_CLI_STDOUT: modelsDocument([
          { id: 'gemini-stdout-marker', label: 'Gemini stdout marker' },
        ]),
        FAKE_AGY_CLI_STDERR: SECRET_URL,
      })),
      (error: unknown) => {
        assertFailure(error, 'query_failed', 'Antigravity CLI model query failed.', 'RUNTIME_ERROR');
        assert.equal(error.message.includes('gemini-stdout-marker'), false);
        assert.equal(error.message.includes('2'), false);
        return true;
      },
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a missing helper is a fixed unavailable error and PATH is not searched', async () => {
  const paths = await makePaths();
  const decoyReport = join(paths.root, 'decoy-report.json');
  const decoy = join(paths.root, 'path-bin', 'agy');
  await installFake(decoy);
  try {
    await assert.rejects(
      listAntigravityCliModels(queryOptions(paths, {
        PATH: dirname(decoy),
        FAKE_AGY_CLI_STDOUT: modelsDocument([]),
      }, {
        candidates: [join(paths.root, 'missing', 'agy'), 'agy'],
      })),
      (error: unknown) => {
        assertFailure(
          error,
          'helper_missing',
          'Antigravity CLI helper is not installed.',
          'RUNTIME_UNAVAILABLE',
        );
        return true;
      },
    );
    await assertAbsent(paths.report);
    await assertAbsent(decoyReport);
    await assertAbsent(paths.pidPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('selects the first absolute regular executable and resolves a safe symlink', async () => {
  const paths = await makePaths();
  const directory = join(paths.root, 'directory-candidate');
  const inert = join(paths.root, 'inert', 'agy');
  const loopA = join(paths.root, 'loop-a');
  const loopB = join(paths.root, 'loop-b');
  const chosen = join(paths.root, 'chosen', 'agy');
  const later = join(paths.root, 'later', 'agy');
  const cellar = join(paths.root, 'Cellar', 'agy', '1.3.5', 'bin', 'agy');
  const link = join(paths.root, 'opt', 'agy');
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(inert), { recursive: true });
  await writeFile(inert, 'not executable', { mode: 0o644 });
  await chmod(inert, 0o644);
  await symlink(loopB, loopA);
  await symlink(loopA, loopB);
  await installFake(chosen);
  await installFake(later);
  await installFake(cellar);
  try {
    await mkdir(dirname(link), { recursive: true });
    await symlink(cellar, link);
    const selected = await listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
      FAKE_AGY_CLI_MARKER: 'chosen',
    }, {
      candidates: [
        join(paths.root, 'missing', 'agy'),
        directory,
        inert,
        loopA,
        'agy',
        chosen,
        later,
      ],
    }));
    assert.equal(selected.helper.path, await realpath(chosen));
    assert.equal(selected.helper.source, 'injected');
    assert.equal((await readReport(paths.report)).marker, 'chosen');

    const linked = await listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
      FAKE_AGY_CLI_MARKER: 'linked',
    }, { candidates: [link] }));
    assert.equal(linked.helper.path, await realpath(cellar));
    assert.equal(linked.helper.path.includes(`${join('Cellar', 'agy')}`), true);
    assert.notEqual(linked.helper.path, link);
    assert.equal((await readReport(paths.report)).marker, 'linked');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('default Gemini roots still fail when HOME is another account and do not spawn', async () => {
  const paths = await makePaths();
  const managed = join(paths.root, 'other-account');
  await mkdir(managed, { recursive: true });
  const cases: NodeJS.ProcessEnv[] = [
    {
      HOME: managed,
      GIAN_AGENT_HOME: join(paths.home, '.gemini'),
    },
    {
      HOME: managed,
      GEMINI_HOME: join(paths.home, '.gemini'),
    },
  ];
  try {
    for (const env of cases) {
      await assert.rejects(
        listAntigravityCliModels(queryOptions(paths, {
          ...env,
          FAKE_AGY_CLI_STDOUT: modelsDocument([
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
          ]),
        })),
        (error: unknown) => {
          assertFailure(error, 'home_not_default', HOME_MESSAGE, 'RUNTIME_ERROR');
          assert.equal(error.message.includes(managed), false);
          return true;
        },
      );
      await assertAbsent(paths.report);
      await assertAbsent(paths.pidPath);
    }
    await assert.rejects(
      listAntigravityCliModels({
        osUserHome: paths.home,
        cwd: paths.cwd,
        candidates: [paths.helper],
        env: {
          PATH: '/usr/bin:/bin',
          FAKE_AGY_CLI_REPORT: paths.report,
          FAKE_AGY_CLI_PID: paths.pidPath,
          FAKE_AGY_CLI_STDOUT: modelsDocument([
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
          ]),
        },
      }),
      (error: unknown) => {
        assertFailure(error, 'home_not_default', HOME_MESSAGE, 'RUNTIME_ERROR');
        return true;
      },
    );
    await assertAbsent(paths.report);
    await assertAbsent(paths.pidPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('custom and managed homes fail before spawn', async () => {
  const paths = await makePaths();
  const managed = join(paths.root, 'managed-home');
  await mkdir(managed, { recursive: true });
  const cases: NodeJS.ProcessEnv[] = [
    { GIAN_AGENT_HOME: '/srv/agent-home' },
    { GEMINI_HOME: join(paths.root, 'custom-gemini') },
    {
      GIAN_AGENT_HOME: join(paths.home, '.gemini'),
      GEMINI_HOME: join(paths.root, 'custom-gemini'),
    },
    { HOME: managed },
    { GEMINI_HOME: 'relative/gemini' },
    { GIAN_AGENT_HOME: `/tmp/bad\0home` },
  ];
  try {
    for (const env of cases) {
      await assert.rejects(
        listAntigravityCliModels(queryOptions(paths, {
          ...env,
          FAKE_AGY_CLI_STDOUT: modelsDocument([]),
        })),
        (error: unknown) => {
          assertFailure(error, 'home_not_default', HOME_MESSAGE, 'RUNTIME_ERROR');
          assert.equal(error.message.includes('relative'), false);
          assert.equal(error.message.includes('srv'), false);
          return true;
        },
      );
      await assertAbsent(paths.report);
      await assertAbsent(paths.pidPath);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('an explicit default Gemini home is queried and not rewritten', async () => {
  const paths = await makePaths();
  const target = join(paths.root, 'gemini-target');
  const linkedHome = join(paths.home, '.gemini');
  await mkdir(target, { recursive: true });
  await symlink(target, linkedHome);
  const slashHome = `${linkedHome}/`;
  try {
    const passed = await listAntigravityCliModels(queryOptions(paths, {
      GEMINI_HOME: slashHome,
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
    }));
    assert.equal(passed.models.length, 1);
    assert.equal((await readReport(paths.report)).geminiHome, slashHome);
    assert.equal((await readReport(paths.report)).gianAgentHome, null);

    const expanded = await listAntigravityCliModels(queryOptions(paths, {
      GIAN_AGENT_HOME: '~/.gemini',
      FAKE_AGY_CLI_MARKER: 'tilde',
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
    }));
    const tilde = await readReport(paths.report);
    assert.equal(expanded.models[0]?.id, 'gemini-3.8-flash-high');
    assert.equal(tilde.gianAgentHome, '~/.gemini');
    assert.equal(tilde.geminiHome, null);
    assert.equal(tilde.marker, 'tilde');

    const same = await listAntigravityCliModels(queryOptions(paths, {
      GEMINI_HOME: target,
      FAKE_AGY_CLI_MARKER: 'canonical',
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
    }));
    assert.equal(same.helper.source, 'injected');
    assert.equal((await readReport(paths.report)).marker, 'canonical');
    assert.equal((await readReport(paths.report)).geminiHome, target);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('times out and does not keep the helper process', async () => {
  const paths = await makePaths();
  let leader = 0;
  const started = Date.now();
  try {
    const pending = listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_DELAY_MS: '10000',
      FAKE_AGY_CLI_STDERR: SECRET_URL,
    }, { timeoutMs: 200, stopMs: 1_000 }));
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(error, 'timeout', 'Antigravity CLI model query timed out.', 'RUNTIME_ERROR');
      return true;
    });
    assert.equal(processAlive(leader), false);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    if (leader > 0) await killPid(leader);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('enforces the output limit without returning the bytes', async () => {
  const paths = await makePaths();
  let leader = 0;
  try {
    const pending = listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_BYTES: '65536',
      FAKE_AGY_CLI_STDERR: SECRET_URL,
    }, { maxOutputBytes: 1024, timeoutMs: 2_000, stopMs: 1_000 }));
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(
        error,
        'output_limit',
        'Antigravity CLI model query exceeded its output limit.',
        'RUNTIME_ERROR',
      );
      assert.equal(error.message.includes('aaa'), false);
      return true;
    });
    assert.equal(processAlive(leader), false);
  } finally {
    if (leader > 0) await killPid(leader);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('stderr bytes count toward the output limit and are not returned', async () => {
  const paths = await makePaths();
  let leader = 0;
  const started = Date.now();
  try {
    const pending = listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_STDERR_BYTES: '4096',
      FAKE_AGY_CLI_STDOUT: modelsDocument([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      ]),
    }, { maxOutputBytes: 128, timeoutMs: 2_000, stopMs: 1_000 }));
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(
        error,
        'output_limit',
        'Antigravity CLI model query exceeded its output limit.',
        'RUNTIME_ERROR',
      );
      assert.equal(error.message.includes('sss'), false);
      assert.equal(error.message.includes('gemini'), false);
      return true;
    });
    assert.equal(processAlive(leader), false);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    if (leader > 0) await killPid(leader);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps stdout that a descendant writes after the leader exits', { ...skipWindows, timeout: 5_000 }, async () => {
  const paths = await makePaths();
  const descendantPath = join(paths.root, 'late-descendant.pid');
  const full = modelsDocument([
    { id: 'gemini-late-tail', label: 'Gemini Late Tail' },
  ]);
  const marker = full.indexOf('gemini-late-tail');
  assert.ok(marker > 0);
  const cut = marker + 'gemi'.length;
  let descendant = 0;
  try {
    const result = await listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_LATE_STDOUT: '1',
      FAKE_AGY_CLI_STDOUT_PREFIX: full.slice(0, cut),
      FAKE_AGY_CLI_STDOUT_SUFFIX: full.slice(cut),
      FAKE_AGY_CLI_LATE_DELAY_MS: '40',
      FAKE_AGY_CLI_DESCENDANT_PID: descendantPath,
    }, { timeoutMs: 2_000, stopMs: 1_000 }));
    assert.equal(result.models[0]?.id, 'gemini-late-tail');
    assert.equal(result.models[0]?.label, 'Gemini Late Tail');
    assert.equal(full.slice(0, cut).includes('gemini-late-tail'), false);
    descendant = Number(await waitForText(descendantPath));
    assert.equal(processAlive(descendant), false);
  } finally {
    if (descendant > 0) await killPid(descendant);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a pipe held after the leader exits fails inside the cleanup budget', { ...skipWindows, timeout: 5_000 }, async () => {
  const paths = await makePaths();
  const descendantPath = join(paths.root, 'hold-descendant.pid');
  let descendant = 0;
  const started = Date.now();
  try {
    const pending = listAntigravityCliModels(queryOptions(paths, {
      FAKE_AGY_CLI_HOLD_STDOUT: '1',
      FAKE_AGY_CLI_STDOUT_PREFIX: '{',
      FAKE_AGY_CLI_DESCENDANT_PID: descendantPath,
    }, { timeoutMs: 5_000, stopMs: 300 }));
    pending.catch(() => undefined);
    descendant = Number(await waitForText(descendantPath));
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(error, 'query_failed', 'Antigravity CLI model query failed.', 'RUNTIME_ERROR');
      assert.equal(error.message.includes('{'), false);
      assert.equal(error.message.includes('gemini'), false);
      return true;
    });
    assert.equal(processAlive(descendant), false);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    if (descendant > 0) await killPid(descendant);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('reap does not signal an owned group already confirmed absent', skipWindows, async t => {
  const pid = process.pid;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number): true => {
    assert.equal(target, -pid);
    signals.push(signal);
    throw Object.assign(new Error(SECRET_URL), { code: 'ESRCH' });
  });
  await reapOwnedGroup(pid, 1_000);
  assert.deepEqual(signals, [0]);
});

test('reap confirms disappearance after a racing second signal error without retrying SIGKILL', skipWindows, async t => {
  const pid = process.pid;
  const diagnostics: AntigravityCliModelsCleanupDiagnostic[] = [];
  let probes = 0;
  let kills = 0;
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number): true => {
    assert.equal(target, -pid);
    if (signal === 0) {
      if (++probes <= 2) return true;
      throw Object.assign(new Error(SECRET_URL), { code: 'ESRCH' });
    }
    assert.equal(signal, 'SIGKILL');
    kills += 1;
    throw Object.assign(new Error(SECRET_URL), { code: 'EPERM' });
  });
  await reapOwnedGroup(pid, 1_000, diagnostic => diagnostics.push(diagnostic));
  assert.equal(probes, 3);
  assert.equal(kills, 1);
  assert.deepEqual(diagnostics, [{ phase: 'reap-signal', code: 'EPERM' }]);
  assert.equal(JSON.stringify(diagnostics).includes(SECRET), false);
});

test('a failed reap signal still fails closed for surviving or unobservable members', skipWindows, async t => {
  for (const probeCode of [null, 'EPERM']) {
    await t.test(probeCode === null ? 'members remain' : 'probe cannot confirm absence', async subtest => {
      const pid = process.pid;
      const diagnostics: AntigravityCliModelsCleanupDiagnostic[] = [];
      let kills = 0;
      subtest.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number): true => {
        assert.equal(target, -pid);
        if (signal === 0 && probeCode === null) return true;
        if (signal !== 0) {
          assert.equal(signal, 'SIGKILL');
          kills += 1;
        }
        throw Object.assign(new Error(SECRET_URL), { code: 'EPERM' });
      });
      await assert.rejects(reapOwnedGroup(pid, 1, diagnostic => diagnostics.push(diagnostic)), (error: unknown) => {
        assertFailure(error, 'cleanup_failed', 'Antigravity CLI model query process cleanup failed.', 'RUNTIME_ERROR');
        return true;
      });
      assert.equal(kills, 1);
      assert.deepEqual(diagnostics, [
        { phase: 'reap-signal', code: 'EPERM' },
        { phase: 'reap-deadline', code: null },
      ]);
    });
  }
});

test('stop reaps a held helper and its descendant', skipWindows, async t => {
  const paths = await makePaths();
  const descendantPath = join(paths.root, 'descendant.pid');
  let leader = 0;
  let descendant = 0;
  const catalog = new AntigravityCliModels(queryOptions(paths, {
    FAKE_AGY_CLI_HOLD: '1',
    FAKE_AGY_CLI_DESCENDANT_PID: descendantPath,
    FAKE_AGY_CLI_STDERR: SECRET_URL,
  }, {
    timeoutMs: 5_000,
    stopMs: 1_000,
    onCleanupDiagnostic: diagnostic => t.diagnostic(JSON.stringify({ diagnostic, leader, descendant })),
  }));
  try {
    const pending = catalog.list();
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    descendant = Number(await waitForText(descendantPath));
    assert.equal(processAlive(leader), true);
    assert.equal(processAlive(descendant), true);
    await assert.rejects(catalog.list(), (error: unknown) => {
      assertFailure(error, 'busy', 'Antigravity CLI model query is already running.', 'RUNTIME_ERROR');
      return true;
    });
    await catalog.stop();
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(error, 'cancelled', 'Antigravity CLI model query was cancelled.', 'CANCELLED');
      return true;
    });
    assert.equal(processAlive(leader), false);
    assert.equal(processAlive(descendant), false);
    await assert.rejects(catalog.list(), (error: unknown) => {
      assertFailure(error, 'cancelled', 'Antigravity CLI model query was cancelled.', 'CANCELLED');
      return true;
    });
  } finally {
    await catalog.stop().catch(() => undefined);
    if (leader > 0) await killPid(leader);
    if (descendant > 0) await killPid(descendant);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('an aborted signal and a stopped catalog do not spawn', async () => {
  const paths = await makePaths();
  const controller = new AbortController();
  controller.abort();
  const aborted = new AntigravityCliModels(queryOptions(paths, {
    FAKE_AGY_CLI_STDOUT: modelsDocument([]),
  }, { signal: controller.signal }));
  const stopped = new AntigravityCliModels(queryOptions(paths, {
    FAKE_AGY_CLI_STDOUT: modelsDocument([]),
  }));
  try {
    await assert.rejects(aborted.list(), (error: unknown) => {
      assertFailure(error, 'cancelled', 'Antigravity CLI model query was cancelled.', 'CANCELLED');
      return true;
    });
    await stopped.stop();
    await assert.rejects(stopped.list(), (error: unknown) => {
      assertFailure(error, 'cancelled', 'Antigravity CLI model query was cancelled.', 'CANCELLED');
      return true;
    });
    await assertAbsent(paths.report);
    await assertAbsent(paths.pidPath);
  } finally {
    await aborted.stop().catch(() => undefined);
    await stopped.stop().catch(() => undefined);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a slow query inside an injected deadline uses a private cwd and leaves HOME unchanged', async () => {
  const paths = await makePaths();
  const gemini = join(paths.home, '.gemini');
  await mkdir(gemini, { recursive: true });
  const document = modelsDocument([
    { id: 'gemini-slow', label: 'Gemini Slow' },
  ]);
  const catalog = new AntigravityCliModels(isolatedOptions(paths, {
    GEMINI_HOME: gemini,
    GIAN_AGENT_HOME: gemini,
    FAKE_AGY_CLI_DELAY_MS: '200',
    FAKE_AGY_CLI_STDOUT: document,
  }, { timeoutMs: 1_000, stopMs: 1_000 }));
  const started = Date.now();
  try {
    const first = await catalog.list();
    const firstReport = await readReport(paths.report);
    assert.equal(first.models[0]?.id, 'gemini-slow');
    assert.notEqual(firstReport.cwd, paths.home);
    assert.notEqual(firstReport.cwd, paths.cwd);
    assert.notEqual(firstReport.cwd, gemini);
    assert.ok(firstReport.pwd);
    // The owned cwd is already removed; resolve its surviving parent to
    // compare macOS /var and /private/var without losing path identity.
    assert.equal(join(await realpath(dirname(firstReport.pwd)), basename(firstReport.pwd)), firstReport.cwd);
    assert.equal(firstReport.home, paths.home);
    assert.equal(firstReport.geminiHome, gemini);
    assert.equal(firstReport.gianAgentHome, gemini);
    await assertAbsent(firstReport.cwd);
    assert.equal((await stat(gemini)).isDirectory(), true);

    const second = await catalog.list();
    const secondReport = await readReport(paths.report);
    assert.equal(second.models[0]?.id, 'gemini-slow');
    assert.notEqual(secondReport.cwd, firstReport.cwd);
    assert.equal(secondReport.home, paths.home);
    assert.equal(secondReport.geminiHome, gemini);
    assert.equal(secondReport.gianAgentHome, gemini);
    await assertAbsent(secondReport.cwd);
    assert.equal((await stat(gemini)).isDirectory(), true);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await catalog.stop().catch(() => undefined);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('an injected timeout stays bounded and removes the private cwd', async () => {
  const paths = await makePaths();
  const gemini = join(paths.home, '.gemini');
  await mkdir(gemini, { recursive: true });
  let leader = 0;
  let queryCwd = '';
  const started = Date.now();
  try {
    const pending = listAntigravityCliModels(isolatedOptions(paths, {
      GEMINI_HOME: gemini,
      GIAN_AGENT_HOME: gemini,
      FAKE_AGY_CLI_DELAY_MS: '10000',
      FAKE_AGY_CLI_STDERR: SECRET_URL,
    }, { timeoutMs: 200, stopMs: 1_000 }));
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    queryCwd = (await readReport(paths.report)).cwd;
    const report = await readReport(paths.report);
    assert.equal(report.home, paths.home);
    assert.equal(report.geminiHome, gemini);
    assert.notEqual(queryCwd, paths.home);
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(error, 'timeout', 'Antigravity CLI model query timed out.', 'RUNTIME_ERROR');
      return true;
    });
    assert.equal(processAlive(leader), false);
    await assertAbsent(queryCwd);
    assert.equal((await stat(gemini)).isDirectory(), true);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    if (leader > 0) await killPid(leader);
    if (queryCwd) await rm(queryCwd, { recursive: true, force: true });
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('stop removes the private cwd after the helper is reaped', { ...skipWindows, timeout: 5_000 }, async () => {
  const paths = await makePaths();
  const gemini = join(paths.home, '.gemini');
  await mkdir(gemini, { recursive: true });
  const catalog = new AntigravityCliModels(isolatedOptions(paths, {
    GEMINI_HOME: gemini,
    GIAN_AGENT_HOME: gemini,
    FAKE_AGY_CLI_HOLD: '1',
    FAKE_AGY_CLI_STDERR: SECRET_URL,
  }, { timeoutMs: 5_000, stopMs: 1_000 }));
  let leader = 0;
  let queryCwd = '';
  try {
    const pending = catalog.list();
    pending.catch(() => undefined);
    leader = Number(await waitForText(paths.pidPath));
    queryCwd = (await readReport(paths.report)).cwd;
    assert.equal((await readReport(paths.report)).home, paths.home);
    assert.notEqual(queryCwd, paths.home);
    assert.equal(processAlive(leader), true);
    await catalog.stop();
    await assert.rejects(pending, (error: unknown) => {
      assertFailure(error, 'cancelled', 'Antigravity CLI model query was cancelled.', 'CANCELLED');
      return true;
    });
    assert.equal(processAlive(leader), false);
    await assertAbsent(queryCwd);
    assert.equal((await stat(gemini)).isDirectory(), true);
    assert.equal((await readReport(paths.report)).geminiHome, gemini);
    assert.equal((await readReport(paths.report)).gianAgentHome, gemini);
  } finally {
    await catalog.stop().catch(() => undefined);
    if (leader > 0) await killPid(leader);
    if (queryCwd) await rm(queryCwd, { recursive: true, force: true });
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a failed private-directory removal does not report a successful catalog', async (t) => {
  const realRm = fsPromises.rm;
  const paths = await makePaths();
  const gemini = join(paths.home, '.gemini');
  await mkdir(gemini, { recursive: true });
  t.mock.method(fsPromises, 'rm', async () => {
    throw new Error('cleanup blocked https://secret.example/token');
  });
  const catalog = new AntigravityCliModels(isolatedOptions(paths, {
    GEMINI_HOME: gemini,
    GIAN_AGENT_HOME: gemini,
    FAKE_AGY_CLI_STDOUT: modelsDocument([{ id: 'gemini-slow', label: 'Gemini Slow' }]),
  }, { timeoutMs: 1_000, stopMs: 1_000 }));
  let queryCwd = '';
  try {
    await assert.rejects(catalog.list(), (error: unknown) => {
      assertFailure(
        error,
        'cleanup_failed',
        'Antigravity CLI model query process cleanup failed.',
        'RUNTIME_ERROR',
      );
      return true;
    });
    queryCwd = (await readReport(paths.report)).cwd;
    assert.equal((await stat(queryCwd)).isDirectory(), true);
    assert.notEqual(queryCwd, paths.home);
    assert.notEqual(queryCwd, paths.cwd);
    assert.notEqual(queryCwd, gemini);
    assert.equal((await readReport(paths.report)).home, paths.home);
    assert.equal((await stat(gemini)).isDirectory(), true);
  } finally {
    t.mock.restoreAll();
    await catalog.stop().catch(() => undefined);
    if (queryCwd) await realRm(queryCwd, { recursive: true, force: true });
    await realRm(paths.root, { recursive: true, force: true });
  }
});
