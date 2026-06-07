import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  CollaborationMode,
  InputItem,
  SandboxMode,
  ThinkingLevel,
} from '../core/types.js';

export interface RuntimeNotification {
  method: string;
  params?: unknown;
}

export interface RuntimeServerRequest extends RuntimeNotification {
  id: number | string;
}

export interface RuntimeEventSource {
  on(event: 'debug', handler: (message: string) => void): void;
  on(event: 'notification', handler: (message: RuntimeNotification) => void): void;
  on(event: 'serverRequest', handler: (message: RuntimeServerRequest) => void): void;
  on(event: 'runtimeStopped', handler: () => void): void;
}

export interface CodexRuntime extends RuntimeEventSource {
  ensureStarted(): Promise<void>;
  /** Start a fresh thread. The thread-level sandbox is just the initial
   *  state — actual sandbox/approval policy is set per-turn via `startTurn`,
   *  so we use a permissive default here (workspace-write). */
  startThread(options: {
    cwd: string;
    model?: string | null;
    ephemeral?: boolean;
  }): Promise<{ thread: { id: string } }>;
  resumeThread(threadId: string): Promise<unknown>;
  readThread(threadId: string): Promise<{ thread: unknown }>;
  compactThread(threadId: string): Promise<unknown>;
  startTurn(
    threadId: string,
    input: InputItem[],
    options?: {
      model?: string | null;
      thinking?: ThinkingLevel | null;
      /** Per-turn sandbox override (codex `sandboxPolicy` on TurnStartParams). */
      sandbox?: SandboxMode | null;
      /** Per-turn approval policy override. */
      approvalPolicy?: ApprovalPolicy | null;
      /** Per-turn approvals reviewer override. `auto_review` lets codex's
       *  subagent decide without surfacing to the proxy. */
      approvalsReviewer?: ApprovalsReviewer | null;
      /** Per-turn collaboration mode override. `plan` constrains agent
       *  behavior to exploration + planning. */
      collaborationMode?: CollaborationMode | null;
      reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed' | null;
      serviceTier?: 'fast' | 'flex' | null;
    },
  ): Promise<{ turn: { id: string; status: string } }>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  /** Set a thread's user-facing display name (SESSION-NAME-001). Maps to the
   *  app-server `thread/name/set` RPC so the name shows in `codex resume` /
   *  Codex app listings. Optional so the TTY runtime needn't implement it. */
  setThreadName?(threadId: string, name: string): Promise<unknown>;
  respond(id: number | string, result: unknown): Promise<unknown>;
  listAllModels(): Promise<unknown[]>;
  listSkills(cwd?: string): Promise<SkillsListResponse>;
  unsubscribeThread?(threadId: string): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * Subset of codex `skills/list` v2 RPC response we actually consume.
 * Full schema: codex app-server generate-json-schema → SkillsListResponse.
 */
export interface SkillsListResponse {
  data: SkillsListEntry[];
}

export interface SkillsListEntry {
  cwd: string;
  errors: Array<{ message: string; path: string }>;
  skills: SkillMetadata[];
}

export interface SkillMetadata {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  shortDescription?: string | null;
  interface?: SkillInterface | null;
}

export interface SkillInterface {
  displayName?: string | null;
  shortDescription?: string | null;
  defaultPrompt?: string | null;
  brandColor?: string | null;
  iconLarge?: string | null;
  iconSmall?: string | null;
}
