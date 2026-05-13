import type { EventEnvelope, Session, SystemConfig, Workspace } from '@gian/shared';

export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  path: string;
}

export function makeWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export async function loadWorkspaces(): Promise<Workspace[]> {
  const res = await fetch('/api/workspaces');
  return (await res.json()) as Workspace[];
}

export async function loadSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  return (await res.json()) as Session[];
}

export async function loadEvents(sessionId: string): Promise<EventEnvelope[]> {
  const res = await fetch(`/api/sessions/${sessionId}/events`);
  if (!res.ok) return [];
  return (await res.json()) as EventEnvelope[];
}

export interface WorkingTree {
  /** `ws:<workspace_id>` for workspace primary, `wt:<session_id>` for linked. */
  id: string;
  kind: 'workspace' | 'worktree';
  /** Display label without branch suffix (the UI appends `(branch)`). */
  label: string;
  path: string;
  branch: string | null;
  workspace_id: string;
  workspace_name: string;
  session_id: string | null;
  session_name: string | null;
}

export async function loadWorkingTrees(): Promise<WorkingTree[]> {
  const res = await fetch('/api/working_trees');
  if (!res.ok) return [];
  return (await res.json()) as WorkingTree[];
}

export async function loadTree(workingTreeId: string, path: string): Promise<TreeEntry[]> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/tree?path=${encodeURIComponent(path)}`);
  if (!res.ok) return [];
  return (await res.json()) as TreeEntry[];
}

export async function loadFile(workingTreeId: string, path: string): Promise<{ content: string; size: number } | null> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) return null;
  return (await res.json()) as { content: string; size: number };
}

export interface ChangedEntry {
  path: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  staged: boolean;
  added: number;
  removed: number;
}

export async function loadChanged(workingTreeId: string): Promise<ChangedEntry[]> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/changed`);
  if (!res.ok) return [];
  return (await res.json()) as ChangedEntry[];
}

export async function loadProxyModels(executor: 'claude' | 'codex'): Promise<Array<import('@gian/shared').CcModelCapabilities | import('@gian/shared').CodexModelCapabilities>> {
  const res = await fetch(`/api/proxy/${executor}/models`);
  if (!res.ok) return [];
  const body = (await res.json()) as { models: Array<import('@gian/shared').CcModelCapabilities | import('@gian/shared').CodexModelCapabilities> };
  return body.models ?? [];
}

export async function loadSlashCommands(
  executor: 'claude' | 'codex',
  workspaceId?: string,
): Promise<import('@gian/shared').SlashCommand[]> {
  const url = workspaceId
    ? `/api/proxy/${executor}/slash?workspace=${encodeURIComponent(workspaceId)}`
    : `/api/proxy/${executor}/slash`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { commands?: import('@gian/shared').SlashCommand[] };
  return body.commands ?? [];
}

export async function loadDiff(workingTreeId: string, path: string): Promise<string> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/diff?path=${encodeURIComponent(path)}`);
  if (!res.ok) return '';
  const body = (await res.json()) as { diff: string };
  return body.diff ?? '';
}

export interface WorkspacePatch {
  name?: string;
}

export interface CreateWorkspaceResult {
  workspace: Workspace | null;
  notes: string[];
  error?: string;
}

export interface CreateWorkspaceOptions {
  /** Optional git remote URL to clone — ignored when `path` is set. */
  gitRemote?: string;
  /** Absolute path (~ allowed) to adopt as workspace as-is. When set, no
   *  mkdir/git-init/clone happens; the dir is used verbatim. */
  path?: string;
}

export interface PickFolderResult {
  /** Absolute POSIX path the user selected, or undefined when canceled. */
  path?: string;
  /** True when the native dialog was dismissed by the user. */
  canceled?: boolean;
  /** Set when the host couldn't run the picker (e.g. non-macOS host). */
  error?: string;
}

export async function pickWorkspaceFolder(): Promise<PickFolderResult> {
  const res = await fetch('/api/workspaces/pick-folder', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as PickFolderResult;
  if (!res.ok) {
    return { error: body.error ?? `Picker failed: ${res.status}` };
  }
  return body;
}

export async function createWorkspace(
  name: string,
  options: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceResult> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(options.gitRemote ? { git_remote: options.gitRemote } : {}),
      ...(options.path ? { path: options.path } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { workspace?: Workspace; notes?: string[]; error?: string };
  if (!res.ok) {
    return { workspace: null, notes: body.notes ?? [], error: body.error ?? `Create failed: ${res.status}` };
  }
  return { workspace: body.workspace ?? null, notes: body.notes ?? [] };
}

export async function loadClaudeMd(workspaceId: string): Promise<string> {
  const res = await fetch(`/api/workspaces/${workspaceId}/claude_md`);
  if (!res.ok) return '';
  const body = (await res.json()) as { content: string };
  return body.content ?? '';
}

export async function saveClaudeMd(workspaceId: string, content: string): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${workspaceId}/claude_md`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.ok;
}

export async function updateWorkspace(id: string, patch: WorkspacePatch): Promise<Workspace | null> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return (await res.json()) as Workspace;
}

export async function deleteWorkspace(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
    return { ok: false, error: body.error ?? `Delete failed: ${res.status}` };
  }
  return { ok: true };
}

export async function reorderWorkspaces(ids: string[]): Promise<void> {
  await fetch('/api/workspaces/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export async function loadArchivedSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions?archived=true');
  if (!res.ok) return [];
  return (await res.json()) as Session[];
}

export async function mergeSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/sessions/${id}/merge`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Merge failed: ${res.status}` };
  }
  return { ok: true };
}

export async function dropSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/sessions/${id}/drop`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Drop failed: ${res.status}` };
  }
  return { ok: true };
}

export async function loadSettings(): Promise<SystemConfig | null> {
  const res = await fetch('/api/settings');
  if (!res.ok) return null;
  return (await res.json()) as SystemConfig;
}

export async function saveSettings(partial: Partial<SystemConfig>): Promise<SystemConfig | null> {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (!res.ok) return null;
  return (await res.json()) as SystemConfig;
}

export async function loadBots(): Promise<import('@gian/shared').Bot[]> {
  try {
    const res = await fetch('/api/bots');
    if (!res.ok) return [];
    return (await res.json()) as import('@gian/shared').Bot[];
  } catch {
    return [];
  }
}

export async function createBot(
  body: {
    label: string;
    platform: import('@gian/shared').IMPlatform;
    workspace_id?: string | null;
    mode: import('@gian/shared').BotMode;
    allowed_user_id?: string | null;
    extra: import('@gian/shared').BotExtra;
  },
): Promise<import('@gian/shared').Bot | null> {
  try {
    const res = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as import('@gian/shared').Bot;
  } catch {
    return null;
  }
}

export async function updateBot(
  id: string,
  patch: Partial<import('@gian/shared').Bot>,
): Promise<import('@gian/shared').Bot | null> {
  try {
    const res = await fetch(`/api/bots/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    return (await res.json()) as import('@gian/shared').Bot;
  } catch {
    return null;
  }
}

export async function deleteBot(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/bots/${id}`, { method: 'DELETE' });
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

export async function toggleBot(id: string): Promise<import('@gian/shared').Bot | null> {
  try {
    const res = await fetch(`/api/bots/${id}/toggle`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as import('@gian/shared').Bot;
  } catch {
    return null;
  }
}

/**
 * Fetch the WS auth token for the current login. The login cookie is
 * httpOnly so JS cannot read it directly; this endpoint echoes it back in
 * the JSON body. Returns null if not authenticated (caller should re-login).
 */
export async function fetchWsToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/ws-token');
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

export async function whoAmI(): Promise<{ user: string } | null> {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) return (await res.json()) as { user: string };
    if (res.status === 401) return null;
    return { user: 'dev' };
  } catch {
    return { user: 'dev' };
  }
}

export async function login(username: string, password: string): Promise<{ user: string } | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  return (await res.json()) as { user: string };
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

export async function changePassword(
  current_password: string,
  new_password: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { error: body.error ?? `${res.status}` };
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
}

export type ReconnectComponent = 'codex' | 'claude' | 'discord' | 'slack';

export async function reconnectComponent(component: ReconnectComponent): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/reconnect/${component}`, { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface FileMeta {
  uncommitted: boolean;
  edit_count_today: number;
}

export async function loadFileMeta(workingTreeId: string, path: string): Promise<FileMeta | null> {
  try {
    const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/file_meta?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return (await res.json()) as FileMeta;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Native Sessions (Spaces view → Native Sessions tab)
// ---------------------------------------------------------------------------

export async function loadNativeSessions(
  workspaceId: string,
): Promise<import('@gian/shared').NativeSession[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/native-sessions`);
  if (!res.ok) return [];
  const body = (await res.json()) as import('@gian/shared').ListNativeSessionsResponse;
  return body.sessions ?? [];
}

export async function adoptNativeSession(
  workspaceId: string,
  body: import('@gian/shared').AdoptNativeSessionRequest,
): Promise<{ session: Session | null; error?: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/native-sessions/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { session?: Session; error?: string };
  if (!res.ok) {
    return { session: null, error: data.error ?? `Adopt failed: ${res.status}` };
  }
  return { session: data.session ?? null };
}

export async function deleteNativeSession(
  workspaceId: string,
  executor: 'claude' | 'codex',
  nativeId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/native-sessions/${nativeId}?executor=${executor}`,
    { method: 'DELETE' },
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: data.error ?? `Delete failed: ${res.status}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workspace Config tab — repository info + worktrees
// ---------------------------------------------------------------------------

export interface RepoInfo {
  git: {
    isRepo: boolean;
    remote: string | null;
    defaultBranch: string | null;
    currentBranch: string | null;
    lastCommit: { hash: string; message: string; age: string } | null;
    modifiedCount: number;
  };
  claudeMd: { exists: boolean; lines: number; mtime: string | null };
}

export interface WorkspaceTree {
  id: string;
  kind: 'main' | 'worktree';
  label: string;
  path: string;
  branch: string | null;
  isDirty: boolean;
  modifiedCount: number;
  claudeMd: { exists: boolean; lines: number; mtime: string | null };
  session?: { id: string; name: string | null };
}

export async function loadRepoInfo(workspaceId: string): Promise<RepoInfo | null> {
  const res = await fetch(`/api/workspaces/${workspaceId}/repo-info`);
  if (!res.ok) return null;
  return (await res.json()) as RepoInfo;
}

export async function loadWorkspaceTrees(workspaceId: string): Promise<WorkspaceTree[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/trees`);
  if (!res.ok) return [];
  return (await res.json()) as WorkspaceTree[];
}
