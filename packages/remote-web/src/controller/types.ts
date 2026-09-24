/**
 * Remote Web UI controller contract (proposal §12 / WP5).
 *
 * The production UI talks ONLY to this interface: it receives state from the
 * controller and issues mutations through `actions`. Components never create
 * WebSockets, read cookies, do crypto, or fetch `/api/...` themselves. The
 * fixtures in `fixture.ts` implement the same interface and drive every test
 * and screenshot; the production adapter (relay client, E2EE, cache) is a
 * typed integration point that lands with the Host connector work.
 *
 * Wire types come from `@gian/remote-protocol` — never redefined here.
 * Presentation DTOs for the transcript come from `@gian/chat-ui`.
 */

import type { TranscriptHistoryErrorState, TranscriptItem } from '@gian/chat-ui';
import type {
  EffectiveCapabilities,
  RemoteInteraction,
  RemoteSession,
  RemoteTask,
} from '@gian/remote-protocol';
import type { catalogReadResultSchema } from '@gian/remote-protocol';
import type { z } from 'zod';

/** `catalog.read` result — inferred from the protocol schema (the package
 *  exports no alias for it). */
export type RemoteCatalog = z.infer<typeof catalogReadResultSchema>;

export type ThemeName = 'light' | 'warm' | 'dark' | 'system';
export type AccentName = 'rose' | 'azure' | 'moss' | 'plum';

// ---------------------------------------------------------------------------
// Connection state matrix (proposal §7.4 + §14)
// ---------------------------------------------------------------------------

export type ConnectionState =
  | { kind: 'online' }
  | { kind: 'browser_offline' }
  | { kind: 'relay_reconnecting'; attempt: number }
  | { kind: 'host_offline'; lastSeenAt: number }
  | { kind: 'resyncing'; synced: number; total: number }
  | { kind: 'device_revoked' }
  | { kind: 'version_mismatch'; requiredVersion: string; hostVersion: string };

/** Mutations are only allowed while fully online (§7.4: resync keeps them
 *  disabled until hello + snapshot/resume completes). */
export function mutationsEnabled(connection: ConnectionState): boolean {
  return connection.kind === 'online';
}

// ---------------------------------------------------------------------------
// Mutation state machine: idle -> pending -> canonical success/error/unknown.
// A relay ACK never ends `pending`; only a canonical command result does.
// `unknown` = UNKNOWN_OUTCOME / disconnect without receipt — UI shows
// "状态待确认" + refresh, never a blind retry with a new command id.
// ---------------------------------------------------------------------------

export type MutationPhase = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface MutationRecord {
  commandId: string;
  /** i18n key describing the action (for logs/aria-live). */
  label: string;
  phase: MutationPhase;
  errorCode?: string;
  errorMessage?: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Hosts (multi-pairing) — everything is scoped to the current Host.
// ---------------------------------------------------------------------------

export interface RemoteHostEntry {
  id: string;
  name: string;
  online: boolean;
  sessionCount: number;
  lastSeenAt?: number;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Composer draft (per session, survives offline; §7.4)
// ---------------------------------------------------------------------------

export interface DraftAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface DraftContextItem {
  id: string;
  kind: 'pasted_text' | 'file_ref';
  label: string;
}

export interface DraftDocument {
  id: string;
  label: string;
}

export interface DraftState {
  text: string;
  attachments: DraftAttachment[];
  contextItems: DraftContextItem[];
  document: DraftDocument | null;
}

export function emptyDraft(): DraftState {
  return { text: '', attachments: [], contextItems: [], document: null };
}

export function draftIsEmpty(draft: DraftState): boolean {
  return (
    draft.text.trim() === '' &&
    draft.attachments.length === 0 &&
    draft.contextItems.length === 0 &&
    draft.document === null
  );
}

// ---------------------------------------------------------------------------
// Transcript projection (per session). The production adapter fills `items`
// from session.subscribe/session.page + events; fixtures precompute them.
// `streaming` is only ever true for live state — a stale/offline snapshot
// must not pretend to stream (§12.3).
// ---------------------------------------------------------------------------

export interface TranscriptState {
  items: TranscriptItem[];
  hydrated: boolean;
  streaming: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  cursor?: string;
  historyError: TranscriptHistoryErrorState | null;
}

// ---------------------------------------------------------------------------
// Queue UI
// ---------------------------------------------------------------------------

export type QueueNotice = { kind: 'replaced-remotely' } | null;

// ---------------------------------------------------------------------------
// Interaction cards — UI-level lifecycle of a wire RemoteInteraction.
// ---------------------------------------------------------------------------

export type InteractionPhase =
  | 'pending'
  | 'responding'
  | 'resolved-here'
  | 'resolved-elsewhere'
  | 'expired';

// ---------------------------------------------------------------------------
// Read-only file viewer (§12.3 / 11.4). Handles are opaque; the UI never
// reconstructs an absolute Host path.
// ---------------------------------------------------------------------------

export interface RemoteFileHandle {
  id: string;
  sessionId: string;
  /** Safe display label (basename), never an absolute path. */
  label: string;
  /** Display-only directory hint (e.g. `.husky/`); may be omitted. */
  dirLabel?: string;
}

export type FileViewerState =
  | { status: 'loading'; handle: RemoteFileHandle }
  | { status: 'image'; handle: RemoteFileHandle; dataUrl: string; mime: string }
  | { status: 'ready'; handle: RemoteFileHandle; text: string; sizeLabel: string }
  | { status: 'binary'; handle: RemoteFileHandle }
  | { status: 'changed'; handle: RemoteFileHandle; text: string }
  | { status: 'expired'; handle: RemoteFileHandle }
  | { status: 'too_large'; handle: RemoteFileHandle; limitLabel: string }
  | { status: 'error'; handle: RemoteFileHandle; message: string };

export type FileDownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; pct: number }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Views / navigation (state-driven; no router dependency)
// ---------------------------------------------------------------------------

export type MainView =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'new-chat'; presetTaskId: string }
  | { kind: 'settings' }
  | { kind: 'empty' };

/** Narrow-layout (<768px) full-screen pages; chat is the home page. */
export type MobilePage = 'chat' | 'rail' | 'settings' | 'file' | 'new-chat';

// ---------------------------------------------------------------------------
// Pairing / auth (B1) — standalone pages outside the app shell.
// ---------------------------------------------------------------------------

export type PairingFailure =
  | 'invalid'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'attempt-limit'
  | 'already-claimed'
  | 'host-offline';

export type PairingState =
  | { kind: 'enter-code'; attemptsLeft: number }
  | { kind: 'qr-confirm'; hostName: string; deviceName: string; pairingUrl?: string }
  | { kind: 'waiting'; deviceName: string; expiresAt: number }
  | { kind: 'failed'; reason: PairingFailure; hostName?: string };

export type AuthState =
  | { kind: 'pairing'; pairing: PairingState }
  | { kind: 'challenge-login'; hosts: RemoteHostEntry[] }
  | { kind: 'authenticated' };

// ---------------------------------------------------------------------------
// Top-level state
// ---------------------------------------------------------------------------

export interface RemoteUiState {
  account?: {
    status: 'signed_out' | 'pending' | 'signed_in' | 'error';
    login?: string; userCode?: string; expiresAt?: number; intervalSeconds?: number;
  };
  addingHost?: boolean;
  connectionPhase?: 'auth' | 'relay' | 'sync';
  connectionFailed?: boolean;
  auth: AuthState;
  connection: ConnectionState;
  hosts: RemoteHostEntry[];
  currentHostId: string | null;

  /** Host-scoped snapshot projection (undefined until the first snapshot). */
  workspaces: Array<{ id: string; name: string }>;
  tasks: RemoteTask[];
  sessions: RemoteSession[];
  interactions: RemoteInteraction[];
  /** Per-interaction UI phase, keyed by interaction id. */
  interactionPhases: Record<string, InteractionPhase>;
  /** Last `interaction.respond` failure per interaction id; cleared on retry. */
  interactionErrors: Record<string, string>;
  capabilities: EffectiveCapabilities;
  catalogRevision: string;
  catalog: RemoteCatalog | null;
  /** Set when the Host invalidated the catalog after our last read. */
  catalogInvalidated: boolean;
  /** Proxy branding logos as data URLs, keyed by proxy name, fetched lazily
   *  via `proxy.logo`. Missing entries render the text fallback. */
  logos: Record<string, { light?: string; dark?: string }>;
  snapshotReceivedAt: number | null;

  view: MainView;
  mobilePage: MobilePage;

  transcripts: Record<string, TranscriptState>;
  drafts: Record<string, DraftState>;
  queueNotice: QueueNotice;
  /** Currently open file viewer (null = closed). */
  fileViewer: FileViewerState | null;
  fileDownload: FileDownloadState;

  /** In-flight / recent mutations, keyed by command id. */
  mutations: Record<string, MutationRecord>;
  /** The latest mutation whose outcome is unknown (drives the banner). */
  unknownCommandId: string | null;

  settings: { theme: ThemeName; accent: AccentName };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  workspaceId: string;
  agentId: string;
  taskId: string;
  name?: string;
  model?: string;
  thinking?: string;
  serviceTier?: 'standard' | 'fast';
}

export interface RemoteUiActions {
  startGitHubLogin?(): void;
  pollGitHubLogin?(): void;
  // Host switching — state/cache are partitioned per Host by the controller.
  selectHost(hostId: string): void;
  restoreBrowserSession(): void;
  startPairing(): void;

  // Navigation
  selectSession(sessionId: string): void;
  openNewChat(presetTaskId: string): void;
  openSettings(): void;
  openMobilePage(page: MobilePage): void;
  backToChat(): void;

  // New chat
  refreshCatalog(): void;
  createSession(input: CreateSessionInput): void;

  // Composer (draft edits are local and always allowed, incl. offline)
  setDraftText(sessionId: string, text: string): void;
  addDraftAttachment(sessionId: string, attachment: DraftAttachment): void;
  uploadDraftAttachment(sessionId: string, file: {
    name: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
  }): void;
  addDraftContextItem(sessionId: string, item: DraftContextItem): void;
  setDraftDocument(sessionId: string, doc: DraftDocument | null): void;
  removeDraftAttachment(sessionId: string, attachmentId: string): void;
  removeDraftContextItem(sessionId: string, itemId: string): void;
  /** Idle turn: send. Active turn: enqueue (Queue is the default; steer
   *  happens through the Queue row's Send now). */
  sendDraft(sessionId: string): void;
  stopSession(sessionId: string): void;
  updateSessionConfig(sessionId: string, config: {
    model?: string;
    thinking?: string;
    service_tier?: 'standard' | 'fast';
    approval_mode?: string;
  }): void;
  retryTranscript(sessionId: string): void;
  loadOlderTranscript(sessionId: string): void;

  // Queue (all carry the current queue revision as precondition)
  editQueueEntry(sessionId: string, queueId: string, text: string): void;
  removeQueueEntry(sessionId: string, queueId: string): void;
  clearQueue(sessionId: string): void;
  sendQueueNow(sessionId: string): void;

  // Interactions — only the Host-given opaque action id + collected values.
  respondToInteraction(
    interactionId: string,
    actionId: string,
    values?: Record<string, string | boolean | string[]>,
  ): void;

  // File viewer (read-only)
  openFile(handle: RemoteFileHandle): void;
  closeFile(): void;
  reloadFile(): void;
  downloadFile(): void;

  // Recovery
  refreshState(): void;
  dismissUnknown(commandId: string): void;

  // Settings
  setTheme(theme: ThemeName): void;
  setAccent(accent: AccentName): void;
  disconnectHost(hostId: string): void;
  logoutBrowser(): void;

  // Pairing / auth
  submitPairingCode(code: string): void;
  setPairingDeviceName(name: string): void;
  confirmQrPairing(): void;
  cancelPairing(): void;
  restartPairing(): void;
  challengeLogin(hostId: string): void;
}

export interface RemoteUiController {
  readonly state: RemoteUiState;
  readonly actions: RemoteUiActions;
  /** Store subscription for the React binding (useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
}
