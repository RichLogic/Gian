import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentInstallStatus, Executor } from '@gian/shared';
import { Hono } from 'hono';
import type { AgentManager } from '../src/agents/manager.js';
import {
  buildOnboardingState,
  hasReadyAgent,
  markOnboardingComplete,
  onboardingCompleted,
  resetOnboarding,
  resolveOnboardingProjectRoot,
  saveOnboardingProjectRoot,
} from '../src/onboarding/state.js';
import { openDatabase } from '../src/storage/db.js';
import { saveConfig } from '../src/storage/config.js';
import { registerOnboardingRoutes } from '../src/web/routes/onboarding.js';

function readyAgent(id: Executor, name: string): AgentInstallStatus {
  return {
    id,
    name,
    ready: true,
    cli: { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' },
    proxy: {
      state: 'ready',
      path: `/proxy/${id}`,
      version: '0.1.0',
      source: 'development',
      defaults: { model: '', thinking: '', mode: '' },
    },
    officialInstallUrl: 'https://example.invalid',
  };
}

test('ONBOARD-001 resolves ~/Coding without creating a managed workspaces directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const homePath = join(root, 'home');
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(dataDir);
  t.after(() => db.close());

  const saved = await saveOnboardingProjectRoot(db, '~/Coding', homePath);
  assert.equal(saved.projectRoot, '~/Coding');
  await access(join(homePath, 'Coding'));
  await assert.rejects(access(join(homePath, 'Coding', 'workspaces')));

  const agents = [
    readyAgent('claude', 'Claude Code'),
    readyAgent('codex', 'Codex'),
    readyAgent('kimi', 'Kimi Code'),
  ];
  const before = await buildOnboardingState(db, agents, homePath);
  assert.equal(before.completed, false);
  assert.equal(before.projectRoot, '~/Coding');

  markOnboardingComplete(db);
  assert.equal(onboardingCompleted(db), true);
  resetOnboarding(db);
  assert.equal(onboardingCompleted(db), false);
});

test('ONBOARD-001 rejects relative and filesystem-root project directories', () => {
  assert.throws(() => resolveOnboardingProjectRoot('Coding'), /absolute/);
  assert.throws(() => resolveOnboardingProjectRoot('/'), /filesystem root/);
});

test('ONBOARD-001 requires one ready Agent rather than every Agent', () => {
  const codex = readyAgent('codex', 'Codex');
  const unavailable = {
    ...readyAgent('claude', 'Claude Code'),
    ready: false,
    proxy: {
      ...readyAgent('claude', 'Claude Code').proxy,
      state: 'missing' as const,
      version: null,
    },
  };
  assert.equal(hasReadyAgent([]), false);
  assert.equal(hasReadyAgent([unavailable]), false);
  assert.equal(hasReadyAgent([codex, unavailable]), true);
});

test('WT-001: completing onboarding triggers managed agent instructions for the confirmed root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-onboarding-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(dataDir);
  t.after(() => db.close());
  const projectRoot = join(root, 'projects');
  saveConfig(db, { workspace_root: projectRoot });

  const synced: string[] = [];
  const agents = {
    listAgentStatuses: async () => [readyAgent('codex', 'Codex')],
  } as unknown as AgentManager;
  const app = new Hono();
  registerOnboardingRoutes(app, {
    db,
    agents,
    syncAgentInstructions: async confirmedRoot => {
      synced.push(confirmedRoot);
      return [];
    },
  });

  const response = await app.request('/api/onboarding/complete', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { completed: boolean }).completed, true);
  assert.deepEqual(synced, [projectRoot]);
  assert.equal(onboardingCompleted(db), true);
});
