import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentInstallStatus, Executor } from '@gian/shared';
import {
  buildOnboardingState,
  markOnboardingComplete,
  onboardingCompleted,
  resetOnboarding,
  resolveOnboardingWorkspace,
  saveOnboardingWorkspace,
} from '../src/onboarding/state.js';
import { openDatabase } from '../src/storage/db.js';

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

test('ONBOARD-001 resolves ~/Coding and creates its managed workspaces directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const homePath = join(root, 'home');
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(dataDir);
  t.after(() => db.close());

  const saved = await saveOnboardingWorkspace(db, '~/Coding', homePath);
  assert.equal(saved.workspaceRoot, '~/Coding');
  assert.equal(saved.workspaceDirectory, join(homePath, 'Coding', 'workspaces'));
  await access(saved.workspaceDirectory);

  const agents = [
    readyAgent('claude', 'Claude Code'),
    readyAgent('codex', 'Codex'),
    readyAgent('kimi', 'Kimi Code'),
  ];
  const before = await buildOnboardingState(db, agents, homePath);
  assert.equal(before.completed, false);
  assert.equal(before.workspaceRoot, '~/Coding');
  assert.equal(before.workspaceDirectory, join(homePath, 'Coding', 'workspaces'));

  markOnboardingComplete(db);
  assert.equal(onboardingCompleted(db), true);
  resetOnboarding(db);
  assert.equal(onboardingCompleted(db), false);
});

test('ONBOARD-001 rejects relative and filesystem-root project directories', () => {
  assert.throws(() => resolveOnboardingWorkspace('Coding'), /absolute/);
  assert.throws(() => resolveOnboardingWorkspace('/'), /filesystem root/);
});
