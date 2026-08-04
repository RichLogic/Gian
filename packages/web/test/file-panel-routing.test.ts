import { describe, expect, it } from 'vitest';
import type { WorkingTree } from '../src/api.js';
import { resolveFilePanelRoute } from '../src/presentation/file-panel.js';

const current: WorkingTree = {
  id: 'ws:current',
  kind: 'workspace',
  label: 'current',
  path: '/work/current',
  branch: 'main',
  workspace_id: 'current',
  workspace_name: 'current',
  session_id: null,
  session_name: null,
};

const other: WorkingTree = {
  ...current,
  id: 'ws:other',
  label: 'other',
  path: '/work/other',
  workspace_id: 'other',
  workspace_name: 'other',
};

describe('file panel routing', () => {
  it('locates a file present in the current Files index', () => {
    const route = resolveFilePanelRoute(
      '/work/current/src/index.ts',
      current,
      [current, other],
      new Set(['src/index.ts']),
    );

    expect(route).toEqual({
      sourceTree: current,
      sourceRel: 'src/index.ts',
      revealRel: 'src/index.ts',
      inCurrentFiles: true,
    });
  });

  it('previews a hidden current-project file without claiming a tree location', () => {
    const route = resolveFilePanelRoute(
      '/work/current/.env',
      current,
      [current, other],
      new Set(['src/index.ts']),
    );

    expect(route.sourceTree).toBe(current);
    expect(route.sourceRel).toBe('.env');
    expect(route.revealRel).toBeNull();
    expect(route.inCurrentFiles).toBe(false);
  });

  it('previews a file from another registered tree without opening current Files', () => {
    const route = resolveFilePanelRoute(
      '/work/other/README.md',
      current,
      [current, other],
      new Set(['src/index.ts']),
    );

    expect(route.sourceTree).toBe(other);
    expect(route.sourceRel).toBe('README.md');
    expect(route.revealRel).toBeNull();
    expect(route.inCurrentFiles).toBe(false);
  });

  it('keeps an unregistered absolute path in a panel-only unavailable state', () => {
    const route = resolveFilePanelRoute(
      '/private/tmp/output.log',
      current,
      [current, other],
      new Set(['src/index.ts']),
    );

    expect(route.sourceTree).toBeNull();
    expect(route.sourceRel).toBeNull();
    expect(route.inCurrentFiles).toBe(false);
  });
});
