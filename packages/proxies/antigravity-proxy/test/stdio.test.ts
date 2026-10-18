import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';

import {
  alive,
  DirectProxy,
  StdioHarness,
  type OutgoingLine,
} from './harness.js';

const HOST = { name: 'Gian', version: '0.6.7' };
const POSIX_PAIR = { skip: process.platform === 'win32', timeout: 20_000 };

interface CheckedProxy {
  pluginVersion: string;
  request(method: string, params: Record<string, unknown>, id: string): Promise<OutgoingLine>;
  endInput(): void;
  waitForExit(timeoutMs?: number): Promise<number | null>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, label);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) assert.fail(label);
  return value;
}

function resultOf(line: OutgoingLine): Record<string, unknown> {
  return record(line.payload.result, `${line.method ?? line.id ?? 'result'} result`);
}

function dataOf(line: OutgoingLine): Record<string, unknown> {
  return record(record(line.payload.params, 'params').data, `${line.method ?? 'notification'} data`);
}

function sessionIdOf(line: OutgoingLine): string | undefined {
  const params = line.payload.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const sessionId = (params as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

async function initialize(proxy: CheckedProxy, versions: string[]): Promise<Record<string, unknown>> {
  const line = await proxy.request('initialize', {
    protocol: { name: 'gian.proxy', versions },
    host: HOST,
  }, 'initialize');
  return resultOf(line);
}

async function shutdown(proxy: CheckedProxy): Promise<void> {
  const line = await proxy.request('shutdown', {}, 'shutdown');
  assert.equal(resultOf(line).ok, true);
  proxy.endInput();
  assert.equal(await proxy.waitForExit(10_000), 0);
}

interface CreatedSession {
  streamId: string;
  turnConfigRevision: string;
  turnConfigOptions: Record<string, unknown>[];
}

async function createSession(
  proxy: CheckedProxy,
  sessionId: string,
  cwd: string,
): Promise<CreatedSession> {
  const line = await proxy.request('session.create', {
    sessionId,
    workspace: { cwd, roots: [cwd] },
    config: {},
  }, `create-${sessionId}`);
  const session = record(resultOf(line).session, 'session.create session');
  assert.equal(session.id, sessionId);
  const streamId = session.streamId;
  if (typeof streamId !== 'string' || streamId.length === 0) assert.fail('session.create streamId');
  const turnConfigRevision = session.turnConfigRevision;
  if (typeof turnConfigRevision !== 'string' || turnConfigRevision.length === 0) {
    assert.fail('session.create turnConfigRevision');
  }
  return {
    streamId,
    turnConfigRevision,
    turnConfigOptions: asArray(session.turnConfigOptions, 'turnConfigOptions').map((option) => (
      record(option, 'turn config option')
    )),
  };
}

function isSessionNotification(sessionId: string, turnId: string): (line: OutgoingLine) => boolean {
  return (line) => {
    if (line.kind !== 'notification' || sessionIdOf(line) !== sessionId) return false;
    const params = line.payload.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return false;
    const owner = (params as Record<string, unknown>).turnId;
    return owner === undefined || owner === turnId;
  };
}

async function collectTurn(harness: StdioHarness, sessionId: string, turnId: string): Promise<OutgoingLine[]> {
  const lines: OutgoingLine[] = [];
  while (lines.length < 30) {
    const line = await harness.take(isSessionNotification(sessionId, turnId), 8_000, `${sessionId} turn`);
    lines.push(line);
    if (line.method === 'turn.completed' || line.method === 'turn.failed') return lines;
  }
  throw new Error(`${sessionId} produced no terminal turn notification.`);
}

function assertTextTurn(lines: readonly OutgoingLine[], chunks: readonly string[], stopReason: string): void {
  const deltas = lines.filter((line) => line.method === 'content.delta').map((line) => {
    const delta = dataOf(line).delta;
    assert.equal(typeof delta, 'string');
    return delta;
  });
  assert.deepEqual(deltas, chunks);
  const startedAt = lines.findIndex((line) => line.method === 'turn.started');
  const firstDelta = lines.findIndex((line) => line.method === 'content.delta');
  const lastDelta = lines.findLastIndex((line) => line.method === 'content.delta');
  const completedAt = lines.findIndex((line) => line.method === 'content.completed');
  const terminalAt = lines.findIndex((line) => line.method === 'turn.completed');
  assert.ok(startedAt >= 0, 'turn.started was not observed');
  assert.ok(firstDelta > startedAt, 'content.delta did not follow turn.started');
  assert.ok(lastDelta < completedAt, 'content.completed did not follow the text deltas');
  assert.ok(completedAt < terminalAt, 'turn.completed did not follow content.completed');
  const completed = lines[completedAt];
  const terminal = lines[terminalAt];
  assert.ok(completed && terminal);
  assert.equal(dataOf(completed).kind, 'text');
  assert.equal(dataOf(completed).content, chunks.join(''));
  assert.equal(dataOf(terminal).stopReason, stopReason);
}

function assertLaunch(harness: StdioHarness): void {
  const report = harness.launchReport();
  assert.equal(report.PATH, harness.isolatedPath);
  assert.notEqual(report.PATH, process.env.PATH);
  assert.equal(report.HOME, harness.directory);
  assert.notEqual(report.HOME, process.env.HOME);
  assert.equal(report.execPath, process.execPath);
  assert.equal(report.script, harness.fixturePath);
  assert.equal(report.harness, harness.harnessPath);
  assert.equal(readdirSync(harness.isolatedPath).length, 0);
  assert.equal(basename(harness.serverPath), 'agy_acp_server.par');
  assert.equal(basename(harness.harnessPath), 'localharness_external');
  const wrapper = readFileSync(harness.serverPath, 'utf8');
  assert.equal(wrapper.startsWith('#!/bin/sh\n'), true);
  assert.equal(wrapper.includes(process.execPath), true);
  assert.equal(wrapper.includes(harness.fixturePath), true);
  assert.equal(wrapper.includes('import {'), false);
  const pid = harness.fakePid();
  assert.notEqual(pid, harness.child.pid);
  assert.equal(alive(pid), true);
}

function choiceValues(option: Record<string, unknown>): string[] {
  return asArray(option.choices, `${String(option.id)} choices`).map((choice) => {
    const value = record(choice, 'choice').value;
    if (typeof value !== 'string') assert.fail('choice value');
    return value;
  });
}

test('self-test reports the plugin manifest without a runtime', { timeout: 10_000 }, async (t) => {
  const home = process.env.HOME;
  const proxy = new DirectProxy({ args: ['--self-test'], validate: false });
  t.after(async () => {
    await proxy.dispose();
    assert.equal(process.env.HOME, home);
  });
  const line = await proxy.nextObject();
  assert.deepEqual(line, {
    schemaVersion: 4,
    id: 'io.gian.antigravity',
    pluginVersion: proxy.pluginVersion,
    ok: true,
  });
  proxy.endInput();
  assert.equal(await proxy.waitForExit(5_000), 0);
  assert.equal(process.env.HOME, home);
});

test('bootstrap discovers no runtime without a binary, model, or account', { timeout: 15_000 }, async (t) => {
  const home = process.env.HOME;
  const proxy = new DirectProxy({
    validate: true,
    extraEnv: { GIAN_RUNTIME_BOOTSTRAP: '1' },
  });
  t.after(async () => {
    await proxy.dispose();
    assert.equal(process.env.HOME, home);
  });
  const initialized = await initialize(proxy, ['2.3', '2.2']);
  assert.deepEqual(initialized.protocol, { name: 'gian.proxy', version: '2.2' });
  assert.deepEqual(initialized.plugin, {
    id: 'io.gian.antigravity',
    name: 'Antigravity',
    version: proxy.pluginVersion,
  });
  assert.deepEqual(initialized.process, { scope: 'shared' });
  assert.deepEqual(initialized.capabilities, {
    'runtime.discover': 1,
    'runtime.probe': 1,
    'runtime.install.plan': 1,
  });
  const catalog = resultOf(await proxy.request('catalog.list', {}, 'catalog'));
  assert.equal(catalog.catalogRevision, 'runtime-bootstrap');
  assert.deepEqual(catalog.configOptions, []);
  assert.deepEqual(catalog.specialCatalogs, {});
  const discovered = resultOf(await proxy.request('runtime.discover', {}, 'discover'));
  assert.equal(asArray(discovered.candidates, 'candidates').length, 0);
  const actions = asArray(discovered.setupActions, 'setupActions');
  assert.equal(actions.length > 0, true);
  assert.equal(actions.some((action) => record(action, 'setup action').kind === 'open_url'), true);
  assert.equal(actions.some((action) => record(action, 'setup action').kind === 'select_file'), true);
  await shutdown(proxy);
  assert.equal(process.env.HOME, home);
});

test('stdio session streams Gemini text and reaps the paired ACP process', POSIX_PAIR, async (t) => {
  const home = process.env.HOME;
  const harness = new StdioHarness();
  t.after(async () => {
    await harness.dispose();
    assert.equal(process.env.HOME, home);
  });
  const initialized = await initialize(harness, ['2.3']);
  assert.deepEqual(initialized.protocol, { name: 'gian.proxy', version: '2.3' });
  assert.deepEqual(initialized.process, { scope: 'shared' });
  assert.deepEqual(initialized.capabilities, {
    'catalog.resolve': 1,
    'catalog.modeSemantics': 1,
    interaction: 1,
    'event.reasoning': 1,
    'event.plan': 1,
    'event.usage': 1,
    'runtime.discover': 1,
    'runtime.probe': 1,
    'runtime.install.plan': 1,
    'session.native.list': 1,
  });
  assertLaunch(harness);
  await assert.rejects(
    harness.request('catalog.list', {}, 'catalog-before-session'),
    /default Gemini home/,
  );
  await assert.rejects(
    harness.request('catalog.resolve', {
      catalogRevision: 'cold',
      sessionConfig: {},
      turnConfig: {},
    }, 'resolve-before-session'),
    /default Gemini home/,
  );
  const beforeCreate = harness.runtimeLog();
  assert.equal(beforeCreate.filter((line) => line === 'session/new').length, 0);
  assert.equal(beforeCreate.filter((line) => line === 'session/prompt').length, 0);
  const created = await createSession(harness, 'session-a', harness.workspace);
  await assert.rejects(
    harness.request('catalog.list', {}, 'catalog-after-create'),
    /default Gemini home/,
  );
  const resolved = resultOf(await harness.request('catalog.resolve', {
    catalogRevision: created.turnConfigRevision,
    sessionId: 'session-a',
    streamId: created.streamId,
    sessionConfig: {},
    turnConfig: {},
  }, 'resolve-session'));
  const projected = created.turnConfigOptions;
  assert.deepEqual(projected.map((option) => option.id), ['model', 'mode', 'thought_level']);
  assert.deepEqual(
    asArray(resolved.configOptions, 'resolved configOptions').map((option) => record(option, 'config option').id),
    ['model', 'mode', 'thought_level'],
  );
  const wire = JSON.stringify({ snapshot: projected, resolved });
  assert.equal(wire.includes('"role"'), false);
  assert.equal(wire.includes('claude-sonnet'), false);
  assert.equal(wire.includes('Gemini-upper'), false);
  assert.equal(wire.includes('"flag"'), false);
  assert.equal(projected.some((option) => option.control === 'boolean'), false);
  const special = record(resolved.specialCatalogs, 'specialCatalogs');
  assert.equal(special.model, 'model');
  assert.equal(special.approvalMode, 'mode');
  assert.equal(special.thinking, 'thought_level');
  const model = projected[0];
  const mode = projected[1];
  const thinking = projected[2];
  assert.ok(model && mode && thinking);
  assert.deepEqual(choiceValues(model), ['gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.equal(model.defaultValue, 'gemini-2.5-pro');
  assert.deepEqual(choiceValues(mode), ['plan', 'ask']);
  assert.equal(mode.defaultValue, 'plan');
  assert.deepEqual(choiceValues(thinking), ['low', 'high']);
  assert.equal(thinking.defaultValue, 'high');
  const afterCreate = harness.runtimeLog();
  assert.equal(afterCreate.filter((line) => line === 'session/new').length, 1);
  assert.equal(afterCreate.filter((line) => line === 'session/prompt').length, 0);
  await harness.request('turn.start', {
    sessionId: 'session-a',
    streamId: created.streamId,
    turnId: 'turn-a',
    input: [{ type: 'text', text: 'stream-hello' }],
    config: {},
  }, 'start-a');
  assertTextTurn(await collectTurn(harness, 'session-a', 'turn-a'), ['hel', 'lo'], 'completed');
  const log = harness.runtimeLog();
  assert.equal(log.filter((line) => line === 'session/prompt').length, 1);
  assert.equal(log.includes('authenticate'), false);
  const pid = harness.fakePid();
  await shutdown(harness);
  await harness.waitUntilDead(pid);
  assert.equal(process.env.HOME, home);
});

test('production stdio lists Gemini models before any native session', POSIX_PAIR, async (t) => {
  const home = process.env.HOME;
  const harness = new StdioHarness({
    coldCatalogStdout: JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'models',
        data: {
          models: [
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
            { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
          ],
        },
      },
    }),
  });
  t.after(async () => {
    await harness.dispose();
    assert.equal(process.env.HOME, home);
  });
  const initialized = await initialize(harness, ['2.3']);
  assert.equal(initialized.protocol && record(initialized.protocol, 'protocol').version, '2.3');
  assertLaunch(harness);
  const beforeList = harness.runtimeLog();
  assert.equal(beforeList.filter((line) => line === 'session/new').length, 0);
  assert.equal(beforeList.filter((line) => line === 'session/prompt').length, 0);
  const listed = resultOf(await harness.request('catalog.list', {}, 'catalog-cold'));
  const projected = asArray(listed.configOptions, 'configOptions').map((option) => record(option, 'config option'));
  assert.deepEqual(projected.map((option) => option.id), ['model', 'mode']);
  const model = projected[0];
  assert.ok(model);
  assert.equal(model.defaultValue, null);
  assert.deepEqual(choiceValues(model), ['gemini-3.8-flash-high', 'gemini-3.8-flash']);
  const mode = projected.find(option => option.id === 'mode');
  assert.ok(mode);
  assert.equal(mode.binding, 'turn');
  assert.equal(mode.control, 'select');
  assert.equal(mode.defaultValue, 'default');
  assert.deepEqual(choiceValues(mode), ['default', 'auto_edit', 'yolo']);
  const special = record(listed.specialCatalogs, 'specialCatalogs');
  assert.equal(special.model, 'model');
  assert.equal(special.thinking, undefined);
  assert.equal(special.approvalMode, 'mode');
  assert.equal(JSON.stringify(listed).includes('"role"'), false);
  const beforeResolve = harness.runtimeLog();
  assert.equal(beforeResolve.filter((line) => line === 'session/new').length, 0);
  assert.equal(beforeResolve.filter((line) => line === 'session/prompt').length, 0);
  const revision = listed.catalogRevision;
  if (typeof revision !== 'string' || revision.length === 0) assert.fail('catalogRevision');
  const resolved = resultOf(await harness.request('catalog.resolve', {
    catalogRevision: revision,
    sessionConfig: {},
    turnConfig: {},
  }, 'catalog-resolve'));
  const defaults = record(resolved.resolvedDefaults, 'resolvedDefaults');
  const sessionConfig = record(defaults.sessionConfig, 'sessionConfig');
  const turnConfig = record(defaults.turnConfig, 'turnConfig');
  assert.equal(Object.hasOwn(sessionConfig, 'model'), false);
  assert.equal(Object.hasOwn(turnConfig, 'model'), false);
  assert.equal(turnConfig.mode, 'default');
  assert.equal(JSON.stringify(defaults).includes('null'), false);
  assert.equal(resolved.catalogRevision, revision);
  const afterResolve = harness.runtimeLog();
  assert.equal(afterResolve.filter((line) => line === 'session/new').length, 0);
  assert.equal(afterResolve.filter((line) => line === 'session/prompt').length, 0);
  assert.equal(afterResolve.some(line => line.startsWith('session/set_')), false);
  assert.equal(afterResolve.includes('authenticate'), false);
  assert.equal(harness.cliSpawnCount(), 1);
  await shutdown(harness);
  assert.equal(process.env.HOME, home);
});

test('two sessions approve and cancel permissions without blocking each other', POSIX_PAIR, async (t) => {
  const home = process.env.HOME;
  const harness = new StdioHarness();
  t.after(async () => {
    await harness.dispose();
    assert.equal(process.env.HOME, home);
  });
  await initialize(harness, ['2.3']);
  assertLaunch(harness);
  const streamA = (await createSession(harness, 'session-a', harness.workspace)).streamId;
  const streamB = (await createSession(harness, 'session-b', harness.workspace)).streamId;
  const started = Promise.all([
    harness.request('turn.start', {
      sessionId: 'session-a',
      streamId: streamA,
      turnId: 'turn-a',
      input: [{ type: 'text', text: 'need-approval' }],
      config: {},
    }, 'start-a'),
    harness.request('turn.start', {
      sessionId: 'session-b',
      streamId: streamB,
      turnId: 'turn-b',
      input: [{ type: 'text', text: 'need-cancel' }],
      config: {},
    }, 'start-b'),
  ]);
  const permissionA = harness.take(
    (line) => line.method === 'interaction.requested' && sessionIdOf(line) === 'session-a',
    8_000,
    'permission A',
  );
  const permissionB = harness.take(
    (line) => line.method === 'interaction.requested' && sessionIdOf(line) === 'session-b',
    8_000,
    'permission B',
  );
  await started;
  const [requestedA, requestedB] = await Promise.all([permissionA, permissionB]);
  assert.deepEqual(actionIds(requestedA), ['allow', 'reject']);
  assert.deepEqual(actionIds(requestedB), ['allow', 'reject']);
  assert.equal(dataOf(requestedA).title, 'Run tool');
  assert.equal(settled(harness.pendingLines(), 'session-a'), false);
  assert.equal(settled(harness.pendingLines(), 'session-b'), false);
  const interactionB = dataOf(requestedB).interactionId;
  assert.equal(typeof interactionB, 'string');
  await harness.request('interaction.respond', {
    sessionId: 'session-b',
    streamId: streamB,
    turnId: 'turn-b',
    interactionId: interactionB,
    responseId: 'response-b',
    actionId: 'reject',
    values: {},
  }, 'respond-b');
  const cancelled = await collectTurn(harness, 'session-b', 'turn-b');
  const resolvedB = cancelled.find((line) => line.method === 'interaction.resolved');
  const terminalB = cancelled.find((line) => line.method === 'turn.completed');
  assert.ok(resolvedB && terminalB);
  assert.equal(dataOf(resolvedB).outcome, 'submitted');
  assert.equal(dataOf(resolvedB).actionId, 'reject');
  assert.equal(dataOf(terminalB).stopReason, 'cancelled');
  assert.equal(cancelled.some((line) => line.method === 'content.delta'), false);
  assert.ok(cancelled.indexOf(resolvedB) < cancelled.indexOf(terminalB));
  assert.equal(settled(harness.pendingLines(), 'session-a'), false);
  const interactionA = dataOf(requestedA).interactionId;
  assert.equal(typeof interactionA, 'string');
  await harness.request('interaction.respond', {
    sessionId: 'session-a',
    streamId: streamA,
    turnId: 'turn-a',
    interactionId: interactionA,
    responseId: 'response-a',
    actionId: 'allow',
    values: {},
  }, 'respond-a');
  assertTextTurn(await collectTurn(harness, 'session-a', 'turn-a'), ['approved'], 'completed');
  const log = harness.runtimeLog();
  assert.equal(log.filter((line) => line === 'session/prompt').length, 2);
  assert.equal(log.filter((line) => line === 'session/request_permission').length, 2);
  assert.equal(log.includes('authenticate'), false);
  const pid = harness.fakePid();
  await shutdown(harness);
  await harness.waitUntilDead(pid);
  assert.equal(process.env.HOME, home);
});

function actionIds(line: OutgoingLine): string[] {
  return asArray(dataOf(line).actions, 'actions').map((action) => {
    const id = record(action, 'action').id;
    if (typeof id !== 'string') assert.fail('action id');
    return id;
  });
}

function settled(lines: readonly OutgoingLine[], sessionId: string): boolean {
  return lines.some((line) => sessionIdOf(line) === sessionId && (
    line.method === 'interaction.resolved'
    || line.method === 'turn.completed'
    || line.method === 'turn.failed'
  ));
}
