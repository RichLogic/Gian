import type { EventEnvelope, Session, SystemConfig, Task, Workspace } from '@gian/shared';

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

/** Diff comparison scope. Mirrors Codex's five-option picker plus the legacy
 *  `all`:
 *   - `all`      = working tree vs HEAD (staged+unstaged, the historical
 *                  default; default-omitted from the URL so it stays
 *                  byte-identical to the pre-scope endpoint — GitBadge + older
 *                  callers rely on that). Not shown in the UI picker.
 *   - `unstaged` = working tree vs index.
 *   - `staged`   = index vs HEAD.
 *   - `commit`   = HEAD's committed delta (parent..HEAD).
 *   - `branch`   = the whole branch vs its base (merge-base) + untracked.
 *   - `lastturn` = files the agent edited in its most recent turn, vs HEAD. */
export type ChangeScope = 'all' | 'unstaged' | 'staged' | 'commit' | 'branch' | 'lastturn';

export async function loadChanged(
  workingTreeId: string,
  scope: ChangeScope = 'all',
): Promise<ChangedEntry[]> {
  const q = scope === 'all' ? '' : `?scope=${scope}`;
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/changed${q}`);
  if (!res.ok) return [];
  return (await res.json()) as ChangedEntry[];
}

/** Stage a single file (`git add -- <path>`). Index-only — never touches file
 *  contents. Returns true on success. */
export async function stageFile(workingTreeId: string, path: string): Promise<boolean> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

/** Unstage a single file (`git reset HEAD -- <path>`). Index-only. */
export async function unstageFile(workingTreeId: string, path: string): Promise<boolean> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/unstage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return res.ok;
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

export async function loadDiff(
  workingTreeId: string,
  path: string,
  scope: ChangeScope = 'all',
): Promise<string> {
  const params = new URLSearchParams({ path });
  if (scope !== 'all') params.set('scope', scope);
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/diff?${params.toString()}`);
  if (!res.ok) return '';
  const body = (await res.json()) as { diff: string };
  return body.diff ?? '';
}

export interface WorkspacePatch {
  name?: string;
  hidden?: boolean;
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

// ---------------------------------------------------------------------------
// Tasks (PRD-v3) — Subtasks are just sessions filtered by task_id, so there is
// no subtask endpoint here. Tasks are primarily seeded from `state_sync` and
// kept fresh via the WS `task:*` messages; these REST helpers mirror the
// workspace ones for the initial / fallback fetch and the create flow.
// ---------------------------------------------------------------------------

export async function loadTasks(): Promise<Task[]> {
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) return [];
    return (await res.json()) as Task[];
  } catch {
    return [];
  }
}

export async function createTask(input: { name: string; description?: string }): Promise<Task | null> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as Task;
  } catch {
    return null;
  }
}

/** PRD-v3 P3 — get-or-create the Task's read-only Codex Manager session.
 *  Idempotent; the host also broadcasts `session:created` on first creation. */
export async function ensureManagerSession(taskId: string): Promise<Session | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/manager`, { method: 'POST' });
    if (!res.ok) return null;
    return ((await res.json()) as { session: Session }).session;
  } catch {
    return null;
  }
}

/** PRD-v3 P3 A1 — send a message to the Task's Manager. The reply streams back
 *  as transcript events on the returned Manager session id (via WS). */
export async function sendManagerMessage(
  taskId: string,
  text: string,
): Promise<{ session_id: string } | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/manager/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { session_id: string };
  } catch {
    return null;
  }
}

/** PRD-v3 P3 A1 — create a Subtask (session with type='subtask' + task_id)
 *  under a Task. Returns the created session or null. The host broadcasts
 *  `session:created` so the global session list updates. */
export async function createSubtask(
  taskId: string,
  input: {
    workspace_id: string;
    executor: 'claude' | 'codex';
    name?: string;
    model?: string | null;
    approval_mode?: import('@gian/shared').ApprovalMode;
    mode?: 'regular' | 'worktree';
  },
): Promise<Session | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { session: Session }).session;
  } catch {
    return null;
  }
}

/** PRD-v3 P3 — mark a Subtask's session done. The host flips status to 'done'
 *  (sets `completed_at`, spec §B) and runs the summarizer, then broadcasts
 *  `session:updated` so the row reflects it. Fail-soft. */
export async function completeSubtask(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${sessionId}/complete`, { method: 'POST' });
  } catch {
    /* fail-soft: the row stays as-is; the broadcast would have updated it */
  }
}

/** Reopen a completed Subtask (spec §B) — clears `completed_at`. Fail-soft. */
export async function reopenSubtask(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${sessionId}/reopen`, { method: 'POST' });
  } catch {
    /* fail-soft */
  }
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

export type PendingGitOp =
  | { kind: 'merge'; mergeHead: string }
  | { kind: 'rebase' }
  | { kind: 'cherry-pick'; head: string }
  | { kind: 'revert'; head: string };

export interface RepoInfo {
  git: {
    isRepo: boolean;
    remote: string | null;
    defaultBranch: string | null;
    currentBranch: string | null;
    lastCommit: { hash: string; message: string; age: string } | null;
    modifiedCount: number;
    /** Set when the workspace tree is mid-merge / mid-rebase / etc. — surfaces
     *  in the Git tab so the user knows why git operations are stuck. */
    pendingOp: PendingGitOp | null;
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

// ---------------------------------------------------------------------------
// Workspace Git tab — branches, remote branches, fetch
// ---------------------------------------------------------------------------

export interface LocalBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  lastCommit: { hash: string; subject: string; age: string } | null;
  /** Absolute path of the worktree that has this branch checked out, or null. */
  worktreePath: string | null;
  /** True for branches auto-created by Gian worktree sessions — currently
   *  `worktree/*` (and legacy `gian/*` from older sessions). */
  isWorktreeBranch: boolean;
  /** Set when worktreePath corresponds to a Gian session's worktree. */
  session: { id: string; name: string | null } | null;
}

export interface RemoteBranch {
  fullName: string;       // e.g. "origin/main"
  remote: string;         // e.g. "origin"
  branch: string;         // e.g. "main"
  lastCommit: { hash: string; subject: string; age: string };
  hasLocalTracking: boolean;
}

export async function loadBranches(workspaceId: string): Promise<LocalBranch[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/branches`);
  if (!res.ok) return [];
  return (await res.json()) as LocalBranch[];
}

export async function loadRemoteBranches(workspaceId: string, search?: string): Promise<RemoteBranch[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const res = await fetch(`/api/workspaces/${workspaceId}/remote-branches${qs}`);
  if (!res.ok) return [];
  return (await res.json()) as RemoteBranch[];
}

export async function fetchRemotes(workspaceId: string): Promise<{ ok: boolean; fetchedAt?: string; error?: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/fetch`, { method: 'POST' });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const err = (body as { error?: string }).error;
    return { ok: false, error: err ?? `Fetch failed (${res.status})` };
  }
  return body as { ok: boolean; fetchedAt: string };
}

export async function abortPendingGitOp(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/abort-merge`, { method: 'POST' });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) return { ok: false, error: (body as { error?: string }).error ?? `Abort failed (${res.status})` };
  return { ok: true };
}

export async function createLocalBranch(
  workspaceId: string,
  input: { name: string; base?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/branches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    return { ok: false, error: (body as { error?: string }).error ?? `Create failed (${res.status})` };
  }
  return { ok: true };
}

export interface UploadedAttachment {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export async function uploadAttachment(
  sessionId: string,
  blob: Blob,
  filename: string,
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.set('file', blob, filename);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed (${res.status}): ${detail || res.statusText}`);
  }
  return (await res.json()) as UploadedAttachment;
}

export async function openFileWith(
  workingTreeId: string,
  path: string,
  editorId?: string,
): Promise<{ ok: true } | { error: string }> {
  return postOpen(workingTreeId, { path, ...(editorId ? { editor_id: editorId } : {}) });
}

/** Open a file with a named macOS application (from `loadApps`). */
export async function openFileWithApp(
  workingTreeId: string,
  path: string,
  app: string,
): Promise<{ ok: true } | { error: string }> {
  return postOpen(workingTreeId, { path, app });
}

/** Open a file with a fixed system opener: system default, reveal in Finder,
 *  or a Terminal at the file's folder. ('browser' is handled client-side.) */
export async function openFileBuiltin(
  workingTreeId: string,
  path: string,
  builtin: 'default' | 'finder' | 'terminal',
): Promise<{ ok: true } | { error: string }> {
  return postOpen(workingTreeId, { path, builtin });
}

async function postOpen(
  workingTreeId: string,
  body: { path: string; editor_id?: string; app?: string; builtin?: string },
): Promise<{ ok: true } | { error: string }> {
  const res = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/open`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (res.ok) return { ok: true };
  try {
    return await res.json() as { error: string };
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}

/** Installed applications for the "Open with…" menu (macOS; [] elsewhere). */
export async function loadApps(): Promise<string[]> {
  try {
    const res = await fetch('/api/apps');
    if (!res.ok) return [];
    const body = (await res.json()) as { apps?: string[] };
    return body.apps ?? [];
  } catch {
    return [];
  }
}

/** Flat, recursive list of every file path in the working tree (for the
 *  FILES panel search box). Returns [] on error. */
export async function loadAllFiles(workingTreeId: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/files`);
    if (!res.ok) return [];
    const body = (await res.json()) as { files?: string[] };
    return body.files ?? [];
  } catch {
    return [];
  }
}

