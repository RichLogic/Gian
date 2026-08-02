import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

export const HOST_BASE =
  process.env.GIAN_E2E_HOST_BASE ??
  `http://127.0.0.1:${process.env.GIAN_HOST_PORT ?? process.env.GIAN_PORT ?? '8991'}`;

export interface CreatedWorkspace {
  id: string;
  name: string;
  path: string;
  tmpDir: string;
}

/**
 * Create a real temp directory on disk and register it as a workspace via
 * the host REST API.  Returns the workspace record plus the temp dir path
 * so callers can assert on the path and clean up afterwards.
 */
export async function createTestWorkspace(
  request: APIRequestContext,
  namePrefix = 'e2e-ws',
): Promise<CreatedWorkspace> {
  const tmpDir = await mkdtemp(join(tmpdir(), `${namePrefix}-`));
  const name = `${namePrefix}-${Date.now()}`;

  const res = await request.post(`${HOST_BASE}/api/workspaces`, {
    data: { name, path: tmpDir, executor: 'claude' },
  });

  if (!res.ok()) {
    throw new Error(`Failed to create workspace: ${res.status()} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    workspace?: { id: string; name: string; path: string };
  };
  if (!body.workspace) {
    throw new Error('Workspace create response did not include workspace');
  }
  return { id: body.workspace.id, name: body.workspace.name, path: body.workspace.path, tmpDir };
}

/**
 * Delete a workspace via the host REST API and remove the temp directory.
 * Safe to call even if the workspace was never created (swallows 404).
 */
export async function deleteTestWorkspace(
  request: APIRequestContext,
  ws: CreatedWorkspace,
): Promise<void> {
  await request.delete(`${HOST_BASE}/api/workspaces/${ws.id}`).catch(() => {});
  await rm(ws.tmpDir, { recursive: true, force: true }).catch(() => {});
}
