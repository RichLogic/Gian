import type {
  AgentInstallResult,
  AgentProxyDefaults,
  AgentProxyUpdateCheck,
  EventEnvelope,
  Executor,
  ProductExecutor,
  ProxyCatalogEntry,
  Session,
  SystemConfig,
  TerminalOptions,
  Task,
  TraceSnapshot,
  UserAgentStatus,
  Workspace,
  OnboardingState,
  OnboardingProjectRootResult,
  ProxyCapabilities,
} from '@gian/shared';
import { parseListNativeSessionsResponse, parseSessionList } from '@gian/shared';

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
  if (!res.ok) throw new Error(`Session list load failed (${res.status})`);
  return parseSessionList(await res.json());
}

/** Read Core's persisted Trace projection for one Session. */
export async function loadSessionTrace(
  sessionId: string,
  signal?: AbortSignal,
): Promise<TraceSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trace`, { signal });
  if (!response.ok) throw new Error(`Trace snapshot load failed (${response.status})`);
  return await response.json() as TraceSnapshot;
}

export async function loadArchivedSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions?archived=true');
  if (!res.ok) throw new Error(`Archived sessions load failed (${res.status})`);
  return parseSessionList(await res.json());
}

// NOTE: the REST archive/delete session helpers were removed in Phase 3a of
// the UI Operation Layer — all archive/delete entry points (including the git
// pane's session delete, Phase 3b) dispatch the WS-backed session.archive /
// session.delete operations.

export interface EventHistoryPage {
  events: EventEnvelope[];
  nextCursor: number | null;
  hasMore: boolean;
}

export type EventHistoryLoadErrorKind = 'http' | 'network' | 'invalid-response';

/** A history request must never be indistinguishable from a genuinely empty
 * page. Callers use this structured error to retain live transcript state and
 * offer the right retry path. */
export class EventHistoryLoadError extends Error {
  readonly kind: EventHistoryLoadErrorKind;
  readonly status: number | null;
  readonly originalError?: unknown;

  constructor(
    kind: EventHistoryLoadErrorKind,
    message: string,
    options: { status?: number; originalError?: unknown } = {},
  ) {
    super(message);
    this.name = 'EventHistoryLoadError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.originalError = options.originalError;
  }
}

export async function loadEvents(sessionId: string, beforeTurn?: number | null): Promise<EventHistoryPage> {
  const query = beforeTurn == null ? '' : `?before=${encodeURIComponent(beforeTurn)}`;
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/events${query}`);
  } catch (error) {
    throw new EventHistoryLoadError('network', 'Unable to reach the event history endpoint.', {
      originalError: error,
    });
  }
  if (!res.ok) {
    throw new EventHistoryLoadError('http', `Event history request failed with HTTP ${res.status}.`, {
      status: res.status,
    });
  }
  let body: EventHistoryPage | EventEnvelope[];
  try {
    body = (await res.json()) as EventHistoryPage | EventEnvelope[];
  } catch (error) {
    throw new EventHistoryLoadError('invalid-response', 'Event history response was not valid JSON.', {
      status: res.status,
      originalError: error,
    });
  }
  // Development fixtures and an older Host may still return the pre-pagination
  // array. Treat it as one complete page during rolling upgrades.
  if (Array.isArray(body)) return { events: body, nextCursor: null, hasMore: false };
  if (!body || !Array.isArray(body.events) || typeof body.hasMore !== 'boolean'
    || (body.nextCursor !== null && typeof body.nextCursor !== 'number')) {
    throw new EventHistoryLoadError('invalid-response', 'Event history response had an invalid shape.', {
      status: res.status,
    });
  }
  return body;
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

export async function loadWorkingTrees(options: { refresh?: boolean } = {}): Promise<WorkingTree[]> {
  const res = await fetch(`/api/working_trees${options.refresh ? '?refresh=1' : ''}`);
  // Keep transport failure distinct from a legitimate empty list. Callers can
  // then retain the last known-good picker contents instead of flashing empty.
  if (!res.ok) throw new Error(`working trees request failed (${res.status})`);
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

/** Preview a clicked absolute path that is not inside a registered working tree. */
export async function loadAbsoluteFile(path: string): Promise<{ content: string; size: number } | null> {
  const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
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

/** Diff comparison scope. Mirrors Codex's picker plus the legacy `all`:
 *   - `all`      = working tree vs HEAD (staged+unstaged, the historical
 *                  default; default-omitted from the URL so it stays
 *                  byte-identical to the pre-scope endpoint — older
 *                  callers rely on that). Shown in the picker as "Uncommitted".
 *   - `unstaged` = working tree vs index.
 *   - `staged`   = index vs HEAD.
 *   - `commit`   = a single commit's delta (HEAD's by default; `sha` pins
 *                  any commit — the Committed submenu).
 *   - `branch`   = the whole branch vs its base (merge-base) + untracked.
 *   - `lastturn` = persisted files and patches from one exact agent turn;
 *                  Git fills provider-omitted details when available. */
export type ChangeScope = 'all' | 'unstaged' | 'staged' | 'commit' | 'branch' | 'lastturn';

/** A commit on the current branch since it diverged from the remote default. */
export interface BranchCommit {
  sha: string;
  subject: string;
  /** git's relative date (`%cr`), e.g. "19 hours ago". */
  rel: string;
}

/** Branch picker data for the Changes inspector's second row: the checked-out
 *  head, the detected remote-default compare base, and every local + remote
 *  branch. */
export interface BranchList {
  head: string;
  /** Detected remote-default compare base (with local/session fallback), or
   *  null when none could be determined. */
  base: string | null;
  branches: string[];
}

// Git History read model. Kept worktree-scoped and distinct from the Changes
// rail's BranchCommit/ChangedEntry state even though both surfaces reuse the
// same diff renderer.
export interface GitHistoryRef {
  name: string;
  shortName: string;
  kind: 'local' | 'remote' | 'tag';
  target: string;
}

export interface GitHistoryAuthor {
  name: string;
  email: string;
}

export interface GitHistoryCommit {
  sha: string;
  parents: string[];
  author: GitHistoryAuthor;
  authoredAt: string;
  committedAt: string;
  subject: string;
  bodyPreview: string;
  refs: GitHistoryRef[];
  isMerge: boolean;
  isRoot: boolean;
}

export interface GitHistoryPage {
  items: GitHistoryCommit[];
  nextCursor: string | null;
  snapshot: string | null;
  currentRef: string | null;
  /** Actual HEAD commit, independent of the selected ref/filter snapshot. */
  headSha: string | null;
  selectedRef: string;
  availableRefs: GitHistoryRef[];
  /** Returned on the first page; later pages intentionally return []. */
  availableAuthors: GitHistoryAuthor[];
}

export interface GitHistoryChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unknown';
  added: number;
  removed: number;
  binary: boolean;
}

export interface GitHistoryCommitDetail extends GitHistoryCommit {
  body: string;
  base: string;
  files: GitHistoryChangedFile[];
}

export interface GitHistoryFileDiff {
  sha: string;
  base: string;
  path: string;
  diff: string;
  truncated: boolean;
}

export interface GitHistoryReachability {
  sha: string;
  reachable: boolean;
}

export interface GitHistoryFetchResult {
  ok: true;
  fetchedAt: string;
  refsChanged: boolean;
  coalesced: boolean;
}

export class GitHistoryRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly unknownOutcome: boolean;
  readonly refsChanged: boolean;
  readonly status: number;

  constructor(input: {
    code: string;
    message: string;
    retryable?: boolean;
    unknownOutcome?: boolean;
    refsChanged?: boolean;
    status: number;
  }) {
    super(input.message);
    this.name = 'GitHistoryRequestError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.unknownOutcome = input.unknownOutcome ?? false;
    this.refsChanged = input.refsChanged ?? false;
    this.status = input.status;
  }
}

async function gitHistoryResponse<T>(response: Response): Promise<T> {
  const raw = await response.json().catch(() => null) as {
    error?: {
      code?: string;
      message?: string;
      retryable?: boolean;
      unknownOutcome?: boolean;
      refsChanged?: boolean;
    };
  } | null;
  if (!response.ok) {
    throw new GitHistoryRequestError({
      code: raw?.error?.code ?? 'git_history_request_failed',
      message: raw?.error?.message ?? `Git History request failed (${response.status})`,
      retryable: raw?.error?.retryable,
      unknownOutcome: raw?.error?.unknownOutcome,
      refsChanged: raw?.error?.refsChanged,
      status: response.status,
    });
  }
  return raw as T;
}

export async function loadGitHistory(
  workingTreeId: string,
  options: {
    limit?: number;
    cursor?: string | null;
    q?: string;
    ref?: string | null;
    author?: string | null;
  } = {},
): Promise<GitHistoryPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.q) params.set('q', options.q);
  if (options.ref) params.set('ref', options.ref);
  if (options.author) params.set('author', options.author);
  const query = params.size ? `?${params.toString()}` : '';
  const response = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/history${query}`,
  );
  return gitHistoryResponse<GitHistoryPage>(response);
}

export async function loadGitHistoryCommit(
  workingTreeId: string,
  sha: string,
): Promise<GitHistoryCommitDetail> {
  const response = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/history/${encodeURIComponent(sha)}`,
  );
  return gitHistoryResponse<GitHistoryCommitDetail>(response);
}

export async function loadGitHistoryCommitReachability(
  workingTreeId: string,
  sha: string,
): Promise<GitHistoryReachability> {
  const response = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/history/${encodeURIComponent(sha)}/reachability`,
  );
  return gitHistoryResponse<GitHistoryReachability>(response);
}

export async function loadGitHistoryFileDiff(
  workingTreeId: string,
  sha: string,
  path: string,
): Promise<GitHistoryFileDiff> {
  const params = new URLSearchParams({ path });
  const response = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/history/${encodeURIComponent(sha)}/diff?${params.toString()}`,
  );
  return gitHistoryResponse<GitHistoryFileDiff>(response);
}

/** Mutation transport for the registered History Fetch operation only. */
export async function fetchGitHistory(workingTreeId: string): Promise<GitHistoryFetchResult> {
  const response = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/fetch`,
    { method: 'POST' },
  );
  return gitHistoryResponse<GitHistoryFetchResult>(response);
}

export async function loadChanged(
  workingTreeId: string,
  scope: ChangeScope = 'all',
  sha?: string | null,
  base?: string | null,
  sessionId?: string | null,
  turn?: number | null,
): Promise<ChangedEntry[]> {
  const params = new URLSearchParams();
  if (scope !== 'all') params.set('scope', scope);
  if (scope === 'commit' && sha) params.set('sha', sha);
  if (scope === 'branch' && base) params.set('base', base);
  // `ws:`/`ext:` trees don't carry a session server-side; the host validates
  // the id against the tree's workspace before trusting it.
  if (scope === 'lastturn' && sessionId) params.set('session', sessionId);
  if (scope === 'lastturn' && turn != null) params.set('turn', String(turn));
  const q = params.size ? `?${params.toString()}` : '';
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/changed${q}`);
  // Throws on failure: the changes-diff store's list status must distinguish
  // a failed load (error state + retry) from a scope with no changes.
  if (!res.ok) throw new Error(`Changed-files load failed (${res.status})`);
  return (await res.json()) as ChangedEntry[];
}

/** Commits on the branch since divergence — the Changes picker's Committed row. */
export async function loadCommits(workingTreeId: string): Promise<BranchCommit[]> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/commits`);
  if (!res.ok) return [];
  return (await res.json()) as BranchCommit[];
}

/** Branches for the Branch scope's compare-base picker (second row). Named
 *  distinct from the workspace-scoped `loadBranches` below. */
export async function loadBranchList(workingTreeId: string): Promise<BranchList | null> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/branches`);
  if (!res.ok) return null;
  return (await res.json()) as BranchList;
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

export async function loadProxyModels(
  executor: 'claude' | 'codex',
  agentId?: string | null,
): Promise<Array<import('@gian/shared').CcModelCapabilities | import('@gian/shared').CodexModelCapabilities>> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
  const res = await fetch(`/api/proxy/${executor}/models${query}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { models: Array<import('@gian/shared').CcModelCapabilities | import('@gian/shared').CodexModelCapabilities> };
  return body.models ?? [];
}

export async function loadProxyCapabilities(
  executor: Executor,
  agentId?: string | null,
): Promise<ProxyCapabilities> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
  const response = await fetch(`/api/proxy/${executor}/capabilities${query}`);
  return agentResponse<ProxyCapabilities>(response);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return agentResponse<T>(response);
}

/** Query helper for `catalog.resolve`. POST only because the config maps
 *  do not fit a GET query string; the call does not persist Host state. */
export async function loadResolvedProxyCatalog(
  executor: Executor,
  params: {
    catalogRevision: string;
    sessionConfig: Record<string, import('@gian/shared').ConfigValue>;
    turnConfig: Record<string, import('@gian/shared').ConfigValue>;
    sessionId?: string;
  },
  agentId?: string | null,
): Promise<import('@gian/shared').ResolvedProxyCatalog> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
  return postJson(`/api/proxy/${executor}/catalog/resolve${query}`, params);
}

async function agentResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Agent request failed (${response.status})`);
  return body;
}

const AGENT_CACHE_TTL_MS = 30_000;
let agentCache: { agents: UserAgentStatus[]; expiresAt: number } | null = null;
let agentRequest: Promise<UserAgentStatus[]> | null = null;

export function peekAgents(): UserAgentStatus[] | null {
  return agentCache?.agents ?? null;
}

function cacheAgent(agent: UserAgentStatus): UserAgentStatus {
  const current = agentCache?.agents ?? [];
  agentCache = {
    agents: [agent, ...current.filter(candidate => candidate.id !== agent.id)],
    expiresAt: Date.now() + AGENT_CACHE_TTL_MS,
  };
  return agent;
}

/** Saved user Agents with their live path/Proxy probe status. Unsaved
 *  catalog kinds are never listed (issue #97). */
export async function loadAgents(options: { refresh?: boolean } = {}): Promise<UserAgentStatus[]> {
  if (!options.refresh && agentCache && agentCache.expiresAt > Date.now()) return agentCache.agents;
  if (agentRequest) return agentRequest;
  const query = options.refresh ? '?refresh=1' : '';
  agentRequest = fetch(`/api/agents${query}`)
    .then(response => agentResponse<{ agents: UserAgentStatus[] }>(response))
    .then(body => {
      agentCache = { agents: body.agents, expiresAt: Date.now() + AGENT_CACHE_TTL_MS };
      return body.agents;
    })
    .finally(() => { agentRequest = null; });
  return agentRequest;
}

/** Static Proxy-kind catalog metadata (no spawn, no probe). */
export async function loadProxies(): Promise<ProxyCatalogEntry[]> {
  const response = await fetch('/api/proxies');
  const body = await agentResponse<{ proxies: ProxyCatalogEntry[] }>(response);
  return body.proxies;
}

export interface AgentDraftDefaults {
  name: string;
  cliPath: string | null;
}

/** Prefill for a new draft card: numbered name and the kind's existing path. */
export async function loadAgentDraftDefaults(
  proxy: ProductExecutor,
): Promise<AgentDraftDefaults> {
  const response = await fetch(`/api/proxies/${proxy}/draft-defaults`);
  return agentResponse<AgentDraftDefaults>(response);
}

export interface CreateAgentInput {
  name: string;
  proxy: ProductExecutor;
  cliPath?: string | null;
  defaults?: Partial<AgentProxyDefaults>;
}

export async function createAgent(input: CreateAgentInput): Promise<UserAgentStatus> {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await agentResponse<{ agent: UserAgentStatus }>(response);
  return cacheAgent(body.agent);
}

export interface UpdateAgentInput {
  name?: string;
  cliPath?: string | null;
  proxy?: ProductExecutor;
  defaults?: Partial<AgentProxyDefaults>;
}

export async function updateAgent(
  agentId: string,
  patch: UpdateAgentInput,
): Promise<UserAgentStatus> {
  const response = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await agentResponse<{ agent: UserAgentStatus }>(response);
  return cacheAgent(body.agent);
}

export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
  await agentResponse<{ ok: boolean }>(response);
  if (agentCache) {
    agentCache = {
      agents: agentCache.agents.filter(candidate => candidate.id !== agentId),
      expiresAt: agentCache.expiresAt,
    };
  }
}

/** Ask the host to open the native file picker so the user can browse for a
 *  CLI executable instead of typing the path (macOS only; mirrors
 *  `pickWorkspaceFolder`). Resolves to the picked absolute path, or null when
 *  the dialog was canceled. Kind-level: drafts have no Agent id yet. */
export async function pickAgentCliPath(executor: Executor): Promise<string | null> {
  const response = await fetch(`/api/agents/${executor}/pick-cli-path`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as { path?: string; canceled?: boolean; error?: string };
  if (!response.ok) throw new Error(body.error ?? `pick-cli-path failed: ${response.status}`);
  return body.path ?? null;
}

export async function installAgentCli(executor: Executor): Promise<AgentInstallResult> {
  const response = await fetch(`/api/agents/${executor}/install-cli`, {
    method: 'POST',
  });
  return agentResponse<AgentInstallResult>(response);
}

export async function installAgentProxy(executor: Executor): Promise<AgentInstallResult> {
  const response = await fetch(`/api/agents/${executor}/install-proxy`, {
    method: 'POST',
  });
  return agentResponse<AgentInstallResult>(response);
}

/** Read-only "newer compatible Proxy release available?" probe (issue #86).
 *  No agent cache update — nothing about the installed state changes. */
export async function checkAgentProxyUpdate(
  executor: Executor,
): Promise<AgentProxyUpdateCheck> {
  const response = await fetch(`/api/agents/${executor}/check-proxy-update`, {
    method: 'POST',
  });
  return agentResponse<AgentProxyUpdateCheck>(response);
}

export async function loadOnboarding(): Promise<OnboardingState> {
  const response = await fetch('/api/onboarding');
  return agentResponse<OnboardingState>(response);
}

export async function saveOnboardingProjectRoot(
  path: string,
): Promise<OnboardingProjectRootResult> {
  const response = await fetch('/api/onboarding/project-root', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return agentResponse<OnboardingProjectRootResult>(response);
}

export async function completeOnboarding(): Promise<OnboardingState> {
  const response = await fetch('/api/onboarding/complete', { method: 'POST' });
  return agentResponse<OnboardingState>(response);
}

export async function resetOnboarding(): Promise<void> {
  const response = await fetch('/api/onboarding/reset', { method: 'POST' });
  await agentResponse<{ ok: boolean }>(response);
}

export async function loadSlashCommands(
  executor: 'claude' | 'codex',
  workspaceId?: string,
  agentId?: string | null,
): Promise<import('@gian/shared').SlashCommand[]> {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspace', workspaceId);
  if (agentId) params.set('agent', agentId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const url = `/api/proxy/${executor}/slash${query}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { commands?: import('@gian/shared').SlashCommand[] };
  return body.commands ?? [];
}

export async function loadSessionSlashCommands(
  sessionId: string,
): Promise<import('@gian/shared').SlashCommand[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/slash`);
  if (!res.ok) return [];
  const body = (await res.json()) as { commands?: import('@gian/shared').SlashCommand[] };
  return body.commands ?? [];
}

export async function loadNativeConfig(
  sessionId: string,
): Promise<{
  state: import('@gian/shared').ExecutorConfigState;
  options: import('@gian/shared').NativeConfigOption[];
} | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/native-config`);
  if (!res.ok) return null;
  return (await res.json()) as {
    state: import('@gian/shared').ExecutorConfigState;
    options: import('@gian/shared').NativeConfigOption[];
  };
}

export interface FileDiffResult {
  diff: string;
  /** True when the host capped the patch at its safe-output prefix. The
   *  working-tree /diff route does not truncate today, but the history route
   *  does — keep the flag wired so a future cap surfaces instead of silently
   *  rendering a partial patch. */
  truncated: boolean;
}

export async function loadDiff(
  workingTreeId: string,
  path: string,
  scope: ChangeScope = 'all',
  sha?: string | null,
  base?: string | null,
  sessionId?: string | null,
  turn?: number | null,
): Promise<FileDiffResult> {
  const params = new URLSearchParams({ path });
  if (scope !== 'all') params.set('scope', scope);
  if (scope === 'commit' && sha) params.set('sha', sha);
  if (scope === 'branch' && base) params.set('base', base);
  if (scope === 'lastturn' && sessionId) params.set('session', sessionId);
  if (scope === 'lastturn' && turn != null) params.set('turn', String(turn));
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/diff?${params.toString()}`);
  // Throws on failure (Phase 3b): the diff view's loading→fill-or-fail timing
  // must distinguish a failed load (error state + retry) from an empty diff.
  if (!res.ok) throw new Error(`Diff load failed (${res.status})`);
  const body = (await res.json()) as { diff: string; truncated?: boolean };
  return { diff: body.diff ?? '', truncated: body.truncated === true };
}

export interface WorkspacePatch {
  name?: string;
  hidden?: boolean;
  pinned?: boolean;
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

export interface CloneWorkspaceRepoResult {
  /** Absolute path the repo was cloned into (<workspace_root>/<name>). */
  path?: string;
  /** Directory name used for the clone (form name, else URL-derived). */
  name?: string;
  error?: string;
}

/** Clone-only: materialize a git remote under the workspace root WITHOUT
 *  registering a workspace (issue #57 new-workspace form). The form fills
 *  its path field from the result; Create then adopts that path. */
export async function cloneWorkspaceRepo(
  gitRemote: string,
  name?: string,
): Promise<CloneWorkspaceRepoResult> {
  const res = await fetch('/api/workspaces/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ git_remote: gitRemote, ...(name ? { name } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as CloneWorkspaceRepoResult;
  if (!res.ok) {
    return { error: body.error ?? `Clone failed: ${res.status}` };
  }
  return body;
}

export async function loadClaudeMd(workspaceId: string): Promise<string> {
  const res = await fetch(`/api/workspaces/${workspaceId}/claude_md`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `CLAUDE.md load failed (${res.status})`);
  }
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
// kept fresh via the WS `task:*` messages; this REST helper mirrors the
// workspace ones for the initial / fallback fetch. Task creation goes through
// the WS `task:create` operation (`task.create`) — the REST `createTask`
// helper was a dead surface and was deleted in Phase 4 of the UI Operation
// Layer (inventory §5).
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

/** PRD-v3 P3 A1 — create a Subtask (session with type='subtask' + task_id)
 *  under a Task. Returns the created session or null. The host broadcasts
 *  `session:created` so the global session list updates. */
export async function createSubtask(
  taskId: string,
  input: {
    workspace_id: string;
    agent_id?: string;
    executor: import('@gian/shared').Executor;
    name?: string;
    model?: string | null;
    approval_mode?: import('@gian/shared').ApprovalMode;
    thinking_effort?: import('@gian/shared').ThinkingEffort | null;
    service_tier?: 'fast' | null;
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
 *  `session:updated` so the row reflects it. Returns false on failure so the
 *  operation layer can settle the run as failed. */
export async function completeSubtask(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/complete`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reopen a completed Subtask (spec §B) — clears `completed_at`. Returns
 *  false on failure (same contract as `completeSubtask`). */
export async function reopenSubtask(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/reopen`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
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

export async function loadTerminalOptions(): Promise<TerminalOptions> {
  const res = await fetch('/api/settings/terminal-options');
  if (!res.ok) throw new Error(`Failed to load terminal options (${res.status})`);
  return (await res.json()) as TerminalOptions;
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

// ---------------------------------------------------------------------------
// Native Sessions (Spaces view → Native Sessions tab)
// ---------------------------------------------------------------------------

export async function loadNativeSessions(
  workspaceId: string,
): Promise<import('@gian/shared').NativeSession[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/native-sessions`);
  if (!res.ok) return [];
  try {
    return parseListNativeSessionsResponse(await res.json()).sessions;
  } catch {
    return [];
  }
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
  executor: import('@gian/shared').Executor,
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

/** Reveal a working tree in the OS file manager (Finder). Moved here from
 *  the inline fetch in spaces-git-pane.tsx (Phase 3b, inventory §4.1). */
export async function revealWorkingTree(
  workingTreeId: string,
): Promise<{ ok: true } | { error: string }> {
  const res = await fetch(`/api/working_trees/${encodeURIComponent(workingTreeId)}/reveal`, {
    method: 'POST',
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: body.error ?? `Reveal failed (${res.status})` };
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
