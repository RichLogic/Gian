import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode, Executor, NativeConfigOption, NativeConfigValue, ProxyModeCapabilities, Session, SlashCommand, ThinkingEffort } from '@gian/shared';
import { isNativeImageMime } from '../attachments.js';
import {
  loadNativeConfig,
  loadSessionSlashCommands,
} from '../api.js';
import { useT } from '../i18n/index.js';
// Runtime import (not `import type`): registering message.uploadAttachment
// on the product registry is a module side effect.
import { type UploadAttachmentInput } from '../operations/message.js';
import { useOperationDispatchOptional, useSessionOperationPending } from '../operations/use-operations.js';
import { ImageZoomContext } from '../transcript/items.js';
import { ContextUsageIndicator } from './composer/context-usage-indicator.js';
import {
  claudeModelFamily,
  composerModeLabel,
  composerModeOptions,
  defaultEffort,
  defaultModel,
  effortLabel,
  fetchModelsCached,
  fetchModesCached,
  fetchSlashCached,
  flatFiltered,
  getModelsCached,
  getModesCached,
  getSlashCached,
  modelLabel,
  nativeOptionRole,
  slashFilterGrouped,
  supportedEfforts,
} from './composer/capabilities.js';
import type { ProxyModel } from './composer/capabilities.js';
import { BulbIcon, ExecutorMark, NativeOptionDrop, useUpDrop } from './composer/option-drops.js';
export { ContextUsageIndicator } from './composer/context-usage-indicator.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Per-session unsent draft. localStorage key prefix; v2 stores JSON
 *  `{text, attachments}` so unsent ATTACHMENTS survive a session switch too
 *  (v1 stored text only and silently dropped them). Attachments persist as
 *  metadata only (name/mime/size/path) — the bytes already live in the
 *  host's per-session attachment store, so the restored chip previews from
 *  the served `/api/sessions/:id/attachments/:filename` URL. */
const DRAFT_KEY_PREFIX = 'gian.composer.draft.v2.';
const LEGACY_DRAFT_KEY_PREFIX = 'gian.composer.draft.v1.';
const draftKey = (sessionId: string) => `${DRAFT_KEY_PREFIX}${sessionId}`;
const legacyDraftKey = (sessionId: string) => `${LEGACY_DRAFT_KEY_PREFIX}${sessionId}`;

export interface DraftAttachment {
  name: string;
  mime: string;
  size: number;
  /** Absolute path in the host attachment store (upload already done). */
  path: string;
}

interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
}

const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] };

/** Served preview URL for an attachment that already lives in the host's
 *  per-session store — the same endpoint the transcript bubbles use. */
function servedAttachmentUrl(sessionId: string, path: string): string {
  return `/api/sessions/${sessionId}/attachments/${path.split('/').pop() ?? path}`;
}

function readDraft(sessionId: string): ComposerDraft {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments.filter(a =>
              a && typeof a.path === 'string' && typeof a.name === 'string' && typeof a.mime === 'string')
          : [],
      };
    }
    // Legacy v1 draft (plain text) — carried over once, then rewritten as v2.
    const legacy = localStorage.getItem(legacyDraftKey(sessionId));
    return legacy ? { text: legacy, attachments: [] } : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}
function writeDraft(sessionId: string, draft: ComposerDraft): void {
  try {
    if (draft.text || draft.attachments.length > 0) {
      localStorage.setItem(draftKey(sessionId), JSON.stringify(draft));
    } else {
      localStorage.removeItem(draftKey(sessionId));
    }
    localStorage.removeItem(legacyDraftKey(sessionId));
  } catch {
    // localStorage may be unavailable (privacy mode) — drafts become ephemeral.
  }
}

/** Window event the Composer listens for to pick up an externally-injected
 *  draft (e.g. the Changes inspector dropping a "commit and push" prompt into
 *  the active session's input for the user to review before sending). */
const COMPOSER_INJECT_EVENT = 'gian:composer-inject';

/** Append `text` to the given session's draft and notify a mounted Composer
 *  to re-read it. The text is NOT auto-sent — it lands in the textarea so the
 *  user can edit/confirm. Appends (with a blank line) rather than clobbering an
 *  existing draft. */
export function injectComposerDraft(sessionId: string, text: string): void {
  const existing = readDraft(sessionId);
  const next = existing.text ? `${existing.text}\n\n${text}` : text;
  writeDraft(sessionId, { ...existing, text: next });
  try {
    window.dispatchEvent(new CustomEvent(COMPOSER_INJECT_EVENT, { detail: { sessionId } }));
  } catch {
    // no window (SSR/tests) — the draft is still persisted for next mount.
  }
}

interface PendingFile {
  /** Local id so React keys are stable even when name is duplicated. */
  id: string;
  /** Display filename (paste auto-generates `paste-{timestamp}.png`). */
  name: string;
  /** MIME from the source File — echoed up to App so the user_message item
   *  can carry it alongside the path. */
  mime: string;
  size: number;
  sizeLabel: string;
  /** Object URL for thumbnail preview. Composer revokes when the user
   *  removes the chip; on send, ownership transfers to App which revokes
   *  during user_message reconciliation. */
  previewUrl: string;
  /** Absolute path returned by the upload endpoint, or null while uploading. */
  path: string | null;
  /** True while the POST is in flight. */
  uploading: boolean;
  /** Set when the upload fails so the chip can show the error state. */
  error?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rebuild composer chips from a persisted draft. The upload already happened
 *  (path is set), so the chip previews from the host-served URL — no object
 *  URL is created and `URL.revokeObjectURL` on it is a harmless no-op. */
function draftAttachmentsToPending(sessionId: string, attachments: DraftAttachment[]): PendingFile[] {
  return attachments.map(a => ({
    id: crypto.randomUUID(),
    name: a.name,
    mime: a.mime,
    size: a.size,
    sizeLabel: fmtBytes(a.size),
    previewUrl: servedAttachmentUrl(sessionId, a.path),
    path: a.path,
    uploading: false,
  }));
}

/** Attachments worth persisting into the draft: fully uploaded, no error. */
function persistableDraftAttachments(files: PendingFile[]): DraftAttachment[] {
  return files
    .filter((f): f is PendingFile & { path: string } => f.path !== null && !f.uploading && !f.error)
    .map(f => ({ name: f.name, mime: f.mime, size: f.size, path: f.path }));
}

/** A concrete Claude id like `claude-opus-4-8` (synced from the native
 *  session) maps to its `opus`/`sonnet`/`haiku` alias family so the static
 *  alias menu can still highlight the matching row. Returns the input
 *  unchanged when it isn't a recognizable concrete claude id. */
export function Composer({
  session,
  onSend, onSendSkill, onStop, onQueueAdd, onSteer, onSetMode, onSetModel, onSetEffort,
  onSetNativeConfig, onSetServiceTier,
  disabled, running, executor,
  workspaceId,
  footer,
  disabledSubmitBehavior = 'queue',
  variant = 'full',
  placeholder,
}: {
  session: Session;
  onSend: (
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      /** Uploaded attachments for this turn. App owns the `previewUrl`s from
       *  this point — Composer must NOT revoke them; the optimistic echo
       *  reuses them until the server confirms with permanent URLs. */
      attachments?: Array<{
        path: string;
        name: string;
        mime: string;
        size: number;
        previewUrl: string;
      }>;
    },
  ) => void;
  /** Dispatch a skill invocation directly (used for codex user/project skills
   *  — bypasses the input box so the skill runs as a structured input item
   *  rather than being sent as text). */
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onQueueAdd: (
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
  ) => void;
  /** Codex-only mid-turn injection (`turn/steer`): Ctrl+Enter while a turn is
   *  running appends the draft to the ACTIVE turn instead of queueing it.
   *  Omitted for claude / kimi composers — they have no steer primitive. */
  onSteer?: (
    text: string,
    opts?: { attachments?: Array<{ path: string; name: string; mime: string; size?: number }> },
  ) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSetNativeConfig?: (configId: string, value: NativeConfigValue) => void;
  /** codex only: toggle the Fast service tier. Passing this (and executor===
   *  'codex') renders the Fast button. Omitted for claude / minimal composers. */
  onSetServiceTier?: (tier: 'fast' | null) => void;
  disabled: boolean;
  /** A turn is actually in flight — drives the Send→Stop toggle. Distinct
   *  from `disabled`, which also covers lock-out / pending-question. */
  running: boolean;
  disabledSubmitBehavior?: 'queue' | 'block';
  executor: Executor;
  workspaceId?: string;
  footer?: import('react').ReactNode;
  /** `'minimal'` strips the model / approval-mode / attachment / bypass
   *  controls down to a bare textarea + Send/Stop, for embedders that want a
   *  fixed-config composer. The draft-persistence, Send→Stop toggle, width
   *  and keyboard handling are all kept identical to a normal session
   *  composer. (Currently unused — introduced for the retired per-Task
   *  Manager composer.) */
  variant?: 'full' | 'minimal';
  /** Override the idle placeholder text (defaults to `composer.placeholder.idle`). */
  placeholder?: string;
}) {
  const t = useT();
  const minimal = variant === 'minimal';
  const cliExecutor = executor === 'kimi' ? null : executor;
  const zoomImage = useContext(ImageZoomContext);
  // Restore text AND already-uploaded attachments from the per-session draft —
  // before v2 only the text survived a session switch and the chips vanished
  // even though their uploads still existed in the host attachment store.
  const [initialDraft] = useState(() => readDraft(session.id));
  const [text, setText] = useState(initialDraft.text);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(
    () => draftAttachmentsToPending(session.id, initialDraft.attachments),
  );

  // Session swap: snapshot current draft under the OUTGOING session's key,
  // then load the INCOMING session's draft. We use the React-blessed
  // "adjust state during render" pattern so the textarea never paints the
  // outgoing draft against the incoming session id.
  const lastSessionRef = useRef(session.id);
  if (lastSessionRef.current !== session.id) {
    writeDraft(lastSessionRef.current, { text, attachments: persistableDraftAttachments(pendingFiles) });
    for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    const incoming = readDraft(session.id);
    lastSessionRef.current = session.id;
    setText(incoming.text);
    setPendingFiles(draftAttachmentsToPending(session.id, incoming.attachments));
  }
  // Single-turn bypass: ⚡ button toggles. Cleared automatically after the
  // next send so it never persists across turns.
  const [oneShotBypass, setOneShotBypass] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(
    () => cliExecutor
      ? (getSlashCached(cliExecutor, workspaceId) ?? [])
      : [],
  );
  const [slashPopPos, setSlashPopPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [modelPopPos, setModelPopPos] = useState<{ left: number; bottom: number } | null>(null);
  // codex-only up-drops (Thinking / Approval get their own modules per the
  // codex composer redesign; on claude these stay folded into the model popover
  // + segmented control below).
  const thinkDrop = useUpDrop(210);
  const approvalDrop = useUpDrop(340);
  const [models, setModels] = useState<ProxyModel[]>(
    cliExecutor ? (getModelsCached(cliExecutor) ?? []) : [],
  );
  const [proxyModes, setProxyModes] = useState<ProxyModeCapabilities[]>(
    cliExecutor ? (getModesCached(cliExecutor) ?? []) : [],
  );
  const sessionNativeOptions = session.native_config_options ?? [];
  const [nativeOptions, setNativeOptions] = useState(sessionNativeOptions);
  // Pending session.stop run (Phase 2a): the Stop button flips to a stable
  // "stopping" state immediately and duplicate clicks are blocked — both by
  // this disabled state and by the dispatcher's duplicate pending guard.
  const stopping = useSessionOperationPending(session.id, 'session.stop');
  // Operation dispatch for attachment uploads (Phase 2b,
  // message.uploadAttachment). Null only when no operation provider is
  // mounted (standalone test renders) — uploads then fail the chip visibly.
  const dispatch = useOperationDispatchOptional();

  // Fetch model list lazily per executor; cached.
  useEffect(() => {
    if (!cliExecutor) {
      setModels([]);
      return;
    }
    const cached = getModelsCached(cliExecutor);
    if (cached) {
      setModels(cached);
      return;
    }
    let alive = true;
    void fetchModelsCached(cliExecutor)
      .then(list => { if (alive) setModels(list); })
      .catch(() => {
        // Keep rendering the session with its persisted model/effort. The
        // capability menu can retry the next time this executor is mounted.
        if (alive) setModels([]);
      });
    return () => { alive = false; };
  }, [cliExecutor]);

  // Fetch the session-mode vocabulary lazily per executor; cached. Until it
  // resolves (or if it fails) the mode dropdown uses the built-in lists.
  useEffect(() => {
    if (!cliExecutor) {
      setProxyModes([]);
      return;
    }
    const cached = getModesCached(cliExecutor);
    if (cached) {
      setProxyModes(cached);
      return;
    }
    let alive = true;
    void fetchModesCached(cliExecutor)
      .then(list => { if (alive) setProxyModes(list); })
      .catch(() => {
        // Keep rendering the built-in mode lists; the fetch retries the next
        // time this executor's composer is mounted.
        if (alive) setProxyModes([]);
      });
    return () => { alive = false; };
  }, [cliExecutor]);

  // Fetch slash commands lazily; keyed by (executor, workspaceId); cached.
  useEffect(() => {
    if (executor === 'kimi') {
      let alive = true;
      setSlashLoading(true);
      void loadSessionSlashCommands(session.id)
        .then(list => {
          if (!alive) return;
          setSlashCommands(list);
          setSlashLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setSlashCommands([]);
          setSlashLoading(false);
        });
      return () => { alive = false; };
    }
    const cached = getSlashCached(executor, workspaceId);
    if (cached) {
      setSlashCommands(cached);
      return;
    }
    let alive = true;
    setSlashLoading(true);
    void fetchSlashCached(executor, workspaceId)
      .then(list => {
        if (!alive) return;
        setSlashCommands(list);
        setSlashLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setSlashCommands([]);
        setSlashLoading(false);
      });
    return () => { alive = false; };
  }, [executor, session.id, workspaceId]);

  useEffect(() => {
    if (executor !== 'kimi') return;
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { sessionId?: unknown; commands?: unknown }
        | undefined;
      if (detail?.sessionId !== session.id || !Array.isArray(detail.commands)) return;
      setSlashCommands(detail.commands as SlashCommand[]);
    };
    window.addEventListener('gian:session-slash-commands', update);
    return () => window.removeEventListener('gian:session-slash-commands', update);
  }, [executor, session.id]);

  useEffect(() => {
    setNativeOptions(sessionNativeOptions);
  }, [session.id, session.native_config_options]);

  useEffect(() => {
    if (executor !== 'kimi' || sessionNativeOptions.length > 0) return;
    let alive = true;
    void loadNativeConfig(session.id)
      .then(snapshot => {
        if (alive && snapshot) setNativeOptions(snapshot.options);
      })
      .catch(() => {
        // Session content remains usable while native config is unavailable.
      });
    return () => { alive = false; };
  }, [executor, session.id, sessionNativeOptions.length]);

  const currentModel = session.model
    ?? (models.length > 0 && cliExecutor ? defaultModel(models, cliExecutor) : '');
  // Fall back to the default (or first) entry when the active model isn't in
  // the menu — e.g. a concrete id like `claude-opus-4-8` synced from native state
  // that the static alias list doesn't enumerate. Without this the effort grid
  // (keyed off the matched row's supportedEfforts) would render empty.
  const currentModelMeta = models.find(m => m.model === currentModel)
    ?? models.find(m => m.isDefault)
    ?? models[0];
  const explicitThinkLevel = session.thinking_effort;
  const thinkLevel = explicitThinkLevel ?? defaultEffort(currentModelMeta);
  const nativeModelOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'model' && option.type === 'select');
  const nativeEffortOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'effort' && option.type === 'select');
  const nativeModeOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'mode' && option.type === 'select');
  const semanticNativeIds = new Set(
    [nativeModelOption, nativeEffortOption, nativeModeOption]
      .filter((option): option is NativeConfigOption => Boolean(option))
      .map(option => option.id),
  );
  const nativeExtraOptions = nativeOptions.filter(option => !semanticNativeIds.has(option.id));
  // Files are uploaded into the host-owned per-session attachment store before
  // send, so queued turns and restored sessions never depend on the original.
  // (pendingFiles itself is declared up top — the session-swap block needs it.)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelPopRef = useRef<HTMLDivElement>(null);

  // Persist the draft on every text / attachment change so refreshes,
  // accidental closes and session switches don't lose unsent input. The
  // session-swap render-time block above already swaps state to the incoming
  // session's draft, so this effect always writes against the current
  // session id.
  useEffect(() => {
    writeDraft(session.id, { text, attachments: persistableDraftAttachments(pendingFiles) });
  }, [session.id, text, pendingFiles]);

  // External draft injection (Changes inspector → "commit / push / create PR"
  // prompts). The dispatcher has already written the appended draft to
  // localStorage; we just re-read it into the textarea and focus, caret at end.
  useEffect(() => {
    function onInject(e: Event) {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId !== session.id) return;
      setText(readDraft(session.id).text);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    }
    window.addEventListener(COMPOSER_INJECT_EVENT, onInject);
    return () => window.removeEventListener(COMPOSER_INJECT_EVENT, onInject);
  }, [session.id]);

  const activeModel = currentModel;
  const approvalMode = session.approval_mode;
  // Proxy-advertised mode vocabulary once capabilities resolve; built-in
  // fallback lists before that (and on fetch failure).
  const modeOptions = cliExecutor ? composerModeOptions(cliExecutor, proxyModes) : [];
  // Warn colour only for modes that stop asking the user (2026-08-04 — the
  // chip used to be warn unconditionally). Kimi isn't here: its mode chip is
  // the native-option drop with its own styling.
  const approvalRisky = cliExecutor === 'codex'
    ? approvalMode === 'auto' || approvalMode === 'custom' || approvalMode === 'full-access'
    : oneShotBypass || approvalMode === 'auto';

  const slashPrefix = text.startsWith('/') ? text : '';
  const filteredGroups = slashOpen ? slashFilterGrouped(slashCommands, slashPrefix) : [];
  const filtered = flatFiltered(filteredGroups);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [text]);

  useEffect(() => {
    // Minimal variant has no slash UI — never auto-open the popover.
    if (minimal) return;
    // Auto-open / auto-filter the popover based on what the user types.
    // Empty input is a no-op. Typing `/` is the only entry point; the visible
    // slash button was intentionally removed from the composer.
    if (text === '/') {
      setSlashOpen(true);
      setSlashIdx(0);
    } else if (text.startsWith('/') && text.length > 1) {
      const groups = slashFilterGrouped(slashCommands, text);
      if (groups.length > 0) {
        setSlashOpen(true);
        setSlashIdx(0);
      } else {
        setSlashOpen(false);
      }
    } else if (text.length > 0) {
      // Non-slash text → close. Empty text is a no-op (button-controlled).
      setSlashOpen(false);
    }
  }, [text, slashCommands, minimal]);

  useEffect(() => {
    if (!slashOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        ref.current && !ref.current.contains(e.target as Node)
      ) {
        setSlashOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [slashOpen]);

  useLayoutEffect(() => {
    if (!modelPopOpen) { setModelPopPos(null); return; }
    const btn = modelBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setModelPopPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
  }, [modelPopOpen]);

  // Position the slash popover relative to the composer's bounding rect.
  // Portaled to body so it escapes `.composer { overflow: hidden }`.
  useLayoutEffect(() => {
    if (!slashOpen) { setSlashPopPos(null); return; }
    const composer = ref.current?.closest('.composer') as HTMLElement | null;
    if (!composer) return;
    const rect = composer.getBoundingClientRect();
    setSlashPopPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
      width: rect.width,
    });
  }, [slashOpen]);

  useEffect(() => {
    if (!modelPopOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        modelPopRef.current && !modelPopRef.current.contains(e.target as Node) &&
        modelBtnRef.current && !modelBtnRef.current.contains(e.target as Node)
      ) {
        setModelPopOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setModelPopOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelPopOpen]);

  function pickCommand(cmd: SlashCommand) {
    // Codex user/project skills dispatch as a typed input item directly —
    // codex resolves the skill markdown and runs it. Native commands and cc
    // commands fall back to the text-into-input path so the user can edit
    // args before sending.
    const isCodexSkill = executor === 'codex' && (cmd.source === 'user' || cmd.source === 'project') && !!cmd.filePath;
    if (isCodexSkill) {
      setSlashOpen(false);
      onSendSkill(cmd.name.replace(/^\//, ''), cmd.filePath!);
      return;
    }

    setText(cmd.name + ' ');
    setSlashOpen(false);
    ref.current?.focus();
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }, 0);
  }

  function submit() {
    const trimmed = text.trim();
    // Wait for in-flight uploads to land before sending. We allow the send if
    // there's any text OR at least one ready attachment.
    const ready = pendingFiles.filter(f => !f.uploading && !f.error && f.path);
    if (!trimmed && ready.length === 0) return;
    if (pendingFiles.some(f => f.uploading)) return; // chip spinner indicates wait

    const attachments = ready.map(f => ({
      path: f.path!,
      name: f.name,
      mime: f.mime,
      size: f.size,
      previewUrl: f.previewUrl,
    }));
    if (disabled) {
      if (disabledSubmitBehavior === 'block') return;
      onQueueAdd(trimmed, attachments.map(({ path, name, mime, size }) => ({ path, name, mime, size })));
      // Queue path doesn't transfer ownership — revoke previews now.
      for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    } else {
      const opts: {
        oneShotBypass?: true;
        attachments?: Array<{ path: string; name: string; mime: string; size: number; previewUrl: string }>;
      } = {};
      if (oneShotBypass) opts.oneShotBypass = true;
      if (attachments.length > 0) opts.attachments = attachments;
      onSend(trimmed, Object.keys(opts).length > 0 ? opts : undefined);
      if (oneShotBypass) setOneShotBypass(false);
      // App owns the sent attachments' previewUrls now — revoke only the
      // unsent ones (failed uploads / still in flight when user pressed
      // send was blocked above, so this is the failed-upload subset).
      const sentIds = new Set(ready.map(f => f.id));
      for (const f of pendingFiles) {
        if (!sentIds.has(f.id)) URL.revokeObjectURL(f.previewUrl);
      }
    }
    setPendingFiles([]);
    setText('');
  }

  /** Codex ⌘/Ctrl+Enter-while-running: append the draft to the ACTIVE turn via
   *  `turn/steer` instead of queueing it for the next one. Same payload
   *  discipline as submit() — wait for uploads, carry attachments, clear the
   *  draft. No optimistic echo; the host records the user message on the
   *  active turn and broadcasts it back. */
  function steerSubmit() {
    if (!onSteer) return;
    const trimmed = text.trim();
    const ready = pendingFiles.filter(f => !f.uploading && !f.error && f.path);
    if (!trimmed && ready.length === 0) return;
    if (pendingFiles.some(f => f.uploading)) return;
    const attachments = ready.map(f => ({
      path: f.path!,
      name: f.name,
      mime: f.mime,
      size: f.size,
    }));
    onSteer(trimmed, attachments.length > 0 ? { attachments } : undefined);
    for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    setPendingFiles([]);
    setText('');
  }

  function setMode(mode: ApprovalMode) {
    onSetMode(mode);
  }

  function setNativeConfigValue(configId: string, value: NativeConfigValue) {
    setNativeOptions(current => current.map(option =>
      option.id === configId ? { ...option, currentValue: value } : option));
    onSetNativeConfig?.(configId, value);
  }

  // Check if there are ready attachments (uploaded, no errors).
  const canSendAttachmentOnly = pendingFiles.some(f => !f.uploading && !f.error && f.path);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    for (const file of chosen) void uploadOne(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }

  function removeFile(id: string) {
    setPendingFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(f => f.id !== id);
    });
  }

  function uploadOne(file: File): void {
    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const entry: PendingFile = {
      id,
      name: file.name,
      mime: file.type,
      size: file.size,
      sizeLabel: fmtBytes(file.size),
      previewUrl,
      path: null,
      uploading: file.size <= MAX_FILE_BYTES,
      ...(file.size > MAX_FILE_BYTES
        ? { error: t('composer.attachment.tooLarge') }
        : {}),
    };
    setPendingFiles(prev => [...prev, entry]);
    if (file.size > MAX_FILE_BYTES) return;
    if (!dispatch) {
      // No operation provider (standalone render) — fail the chip visibly
      // rather than silently dropping the upload.
      setPendingFiles(prev =>
        prev.map(f => f.id === id ? { ...f, uploading: false, error: t('composer.attachment.uploadUnavailable') } : f),
      );
      return;
    }

    // The pending-file chip UX is unchanged: `uploading` drives the spinner,
    // onFailed sets the error flag. The operation layer correlates the run.
    dispatch<UploadAttachmentInput>('message.uploadAttachment', {
      sessionId: session.id,
      blob: file,
      filename: file.name,
      onUploaded: result =>
        setPendingFiles(prev =>
          prev.map(f => f.id === id
            ? { ...f, path: result.path, mime: result.mime, size: result.size, sizeLabel: fmtBytes(result.size), uploading: false }
            : f),
        ),
      onFailed: message =>
        setPendingFiles(prev =>
          prev.map(f => f.id === id ? { ...f, uploading: false, error: message } : f),
        ),
    });
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Minimal variant has no attachment pipeline — let text paste through
    // normally rather than intercepting images we can't send.
    if (minimal) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (images.length === 0) return; // let normal text paste through
    e.preventDefault();
    for (const it of images) {
      const file = it.getAsFile();
      if (!file) continue;
      if (file.size > MAX_FILE_BYTES) continue; // silently drop; chip would be useless
      // Screenshots have empty name — fabricate one.
      const named = file.name ? file : new File([file], `paste-${Date.now()}.png`, { type: file.type });
      void uploadOne(named);
    }
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx(i => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (filtered[slashIdx]) pickCommand(filtered[slashIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    // ⌘/Ctrl+Enter: with a draft it steers the draft into the ACTIVE turn
    // (codex `turn/steer`) instead of queueing it; on other executors or when
    // idle it submits like plain Enter. With no draft it bubbles to the
    // document-level queue-drain handler.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) {
      const hasDraft = text.trim().length > 0 || pendingFiles.some(f => !f.uploading && !f.error && f.path);
      if (!hasDraft) return;
      e.preventDefault();
      if (onSteer && executor === 'codex' && disabled) steerSubmit();
      else submit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className={`composer-wrap${oneShotBypass ? ' is-bypass' : ''}`}>
      <div
        className="composer"
        style={{ position: 'relative' }}
      >
        {/* Hidden file input — triggered by the plus button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        {oneShotBypass && (
          <div className="composer-bypass-banner" role="status">
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor"
                 strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2L1 22h22z" />
              <path d="M12 9v6" />
              <path d="M12 18v.01" />
            </svg>
            <span>{t('composer.bypass.banner')}</span>
          </div>
        )}

        <div className="composer-input-wrap">
          <textarea
            ref={ref}
            className="composer-ta"
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handlePaste}
            placeholder={
              disabled
                ? t('composer.placeholder.busy')
                : (placeholder ?? t('composer.placeholder.idle'))
            }
          />
        </div>

        {/* Pending attachment chips */}
        {pendingFiles.length > 0 && (
          <div className="composer-attachments">
            {pendingFiles.map(f => (
              <div key={f.id} className={`att-chip${f.error ? ' is-error' : ''}${f.uploading ? ' is-uploading' : ''}`}>
                {isNativeImageMime(f.mime) ? (
                  <button
                    type="button"
                    className="att-thumb-btn"
                    title={f.name}
                    onClick={() => zoomImage?.(f.previewUrl, f.name)}
                  >
                    <img className="att-thumb" src={f.previewUrl} alt={f.name} />
                  </button>
                ) : (
                  <span className="att-file-icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none">
                      <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </span>
                )}
                <span className="att-name" title={f.error ?? f.name}>{f.name}</span>
                <span className="att-size">{f.sizeLabel}</span>
                <button className="att-remove" type="button" onClick={() => removeFile(f.id)} aria-label={t('composer.attachment.remove')}>✕</button>
              </div>
            ))}
          </div>
        )}

        {!minimal && slashOpen && slashPopPos && (slashLoading || filteredGroups.length > 0) && createPortal(
          <div
            ref={popRef}
            className="cmp-slash-pop"
            style={{ left: slashPopPos.left, bottom: slashPopPos.bottom, width: slashPopPos.width }}
          >
            {slashLoading && filtered.length === 0 && (
              <div className="cmp-slash-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>
                <span className="cmp-slash-desc">{t('composer.slash.loading')}</span>
              </div>
            )}
            {filteredGroups.map(group => {
              let baseIdx = 0;
              for (const g of filteredGroups) {
                if (g.source === group.source) break;
                baseIdx += g.items.length;
              }
              return (
                <div key={group.source}>
                  <div className="cmp-slash-section">{t(`composer.slash.source.${group.source}`)}</div>
                  {group.items.map((item, localIdx) => {
                    const flatIdx = baseIdx + localIdx;
                    return (
                      <button
                        key={item.name}
                        type="button"
                        className={`cmp-slash-row${flatIdx === slashIdx ? ' active' : ''}`}
                        data-source={item.source}
                        title={item.filePath}
                        onPointerDown={e => { e.preventDefault(); pickCommand(item); }}
                        onMouseEnter={() => setSlashIdx(flatIdx)}
                      >
                        <span className="cmp-slash-cmd">{item.name}</span>
                        <span className="cmp-slash-desc">{item.description}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}

        <div className="composer-bar">
          {!minimal && executor === 'kimi' && (
            <div className="composer-native-config">
              {nativeModelOption && (
                <NativeOptionDrop
                  option={nativeModelOption}
                  role="model"
                  disabled={disabled || !onSetNativeConfig}
                  onChange={value => setNativeConfigValue(nativeModelOption.id, value)}
                />
              )}
              {nativeEffortOption && (
                <NativeOptionDrop
                  option={nativeEffortOption}
                  role="effort"
                  disabled={disabled || !onSetNativeConfig}
                  onChange={value => setNativeConfigValue(nativeEffortOption.id, value)}
                />
              )}
              {nativeExtraOptions.map(option => (
                option.type === 'boolean' ? (
                  <label
                    key={option.id}
                    className="composer-native-toggle"
                    title={option.description}
                  >
                    <input
                      type="checkbox"
                      checked={option.currentValue === true}
                      disabled={disabled || !onSetNativeConfig}
                      onChange={event => setNativeConfigValue(option.id, event.target.checked)}
                    />
                    <span>{option.name}</span>
                  </label>
                ) : option.type === 'select' ? (
                  <label
                    key={option.id}
                    className="composer-native-select"
                    title={option.description}
                  >
                    <span>{option.name}</span>
                    <select
                      value={String(option.currentValue ?? '')}
                      disabled={disabled || !onSetNativeConfig}
                      aria-label={option.name}
                      onChange={event => {
                        const selected = option.choices?.find(
                          choice => String(choice.value ?? '') === event.target.value,
                        );
                        setNativeConfigValue(
                          option.id,
                          selected ? selected.value : event.target.value,
                        );
                      }}
                    >
                      {(option.choices ?? []).map(choice => (
                        <option
                          key={String(choice.value)}
                          value={String(choice.value ?? '')}
                        >
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label
                    key={option.id}
                    className="composer-native-input"
                    title={option.description}
                  >
                    <span>{option.name}</span>
                    <input
                      key={`${option.id}:${String(option.currentValue)}`}
                      type={option.type === 'number' ? 'number' : 'text'}
                      defaultValue={String(option.currentValue ?? '')}
                      disabled={disabled || !onSetNativeConfig}
                      onBlur={event => setNativeConfigValue(
                        option.id,
                        option.type === 'number'
                          ? Number(event.target.value)
                          : event.target.value,
                      )}
                    />
                  </label>
                )
              ))}
            </div>
          )}
          {!minimal && executor !== 'kimi' && (<>
          {/* Model picker — opens custom model+thinking popover */}
          <div className="composer-model">
          <button
            ref={modelBtnRef}
            type="button"
            className="composer-opt cmp-model-wrap"
            title={t('composer.model.title')}
            onClick={() => setModelPopOpen(v => !v)}
          >
            <ExecutorMark executor={executor} />
            <span className="name cmp-model">{modelLabel(models, activeModel) || activeModel}</span>
            <span className="caret cmp-caret" aria-hidden="true">▾</span>
          </button>
          </div>
          {modelPopOpen && modelPopPos && createPortal(
            <div
              ref={modelPopRef}
              className="popover model-pop"
              role="dialog"
              style={{ left: modelPopPos.left, bottom: modelPopPos.bottom }}
            >
              <div className="mp-section">
                <div className="mp-section-head">
                  <span className="mp-section-title">{t('composer.model.section')}</span>
                  <span className="mp-section-hint">{executor}</span>
                </div>
                <div className="mp-list">
                  {models.length === 0 && (
                    <div className="mp-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>{t('common.loading')}</div>
                  )}
                  {models.filter(m => !m.hidden).map(m => {
                    // Highlight on exact id, or when a concrete synced id
                    // (`claude-opus-4-8`) matches this alias row's family.
                    const active = m.model === activeModel
                      || (!!m.model && m.model === claudeModelFamily(activeModel));
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`mp-row${active ? ' active' : ''}`}
                        onClick={() => { onSetModel(m.model); setModelPopOpen(false); }}
                      >
                        <span className="mp-check">{active ? '✓' : ''}</span>
                        <span className="mp-row-body">
                          <span className="mp-row-title">{m.displayName}</span>
                          {/* codex model list stays plain — name only, like the
                              real Codex app. claude keeps its descriptions. */}
                          {m.description && executor !== 'codex' && <span className="mp-row-hint">{m.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Effort is always its own CLI-backed control. */}
          {cliExecutor && (
            <>
              <button
                ref={thinkDrop.btnRef}
                type="button"
                className={`composer-opt cmp-think-btn${thinkDrop.open ? ' open' : ''}`}
                title={t('composer.reasoning.effort')}
                onClick={() => thinkDrop.setOpen(o => !o)}
              >
                <BulbIcon />
                <span className="name">{effortLabel(cliExecutor, thinkLevel)}</span>
                <span className="caret cmp-caret" aria-hidden="true">▾</span>
              </button>
              {thinkDrop.open && thinkDrop.pos && createPortal(
                <div
                  ref={thinkDrop.popRef}
                  className="popover think-pop"
                  role="dialog"
                  style={{ left: thinkDrop.pos.left, bottom: thinkDrop.pos.bottom }}
                >
                  <div className="mp-section-head">
                    <span className="mp-section-title">{t('composer.reasoning.effort')}</span>
                  </div>
                  <div className="mp-list">
                    {supportedEfforts(currentModelMeta).map(lvl => {
                      const active = thinkLevel === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          className={`mp-row${active ? ' active' : ''}`}
                          onClick={() => { onSetEffort(lvl); thinkDrop.setOpen(false); }}
                        >
                          <span className="mp-check">{active ? '✓' : ''}</span>
                          <span className="mp-row-body">
                            <span className="mp-row-title">{effortLabel(cliExecutor, lvl)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body
              )}
            </>
          )}

          {/* Fast is a Codex-only service tier, not a shared executor mode. */}
          {executor === 'codex' && onSetServiceTier && (
            <button
              type="button"
              className={`composer-opt cmp-fast${session.service_tier === 'fast' ? ' on' : ''}`}
              title={t('composer.fast.title')}
              aria-pressed={session.service_tier === 'fast'}
              onClick={() => onSetServiceTier(session.service_tier === 'fast' ? null : 'fast')}
            >
              {t('composer.fast.button')}
            </button>
          )}

          </>)}

          <span className="spacer" />

          {!minimal && <ContextUsageIndicator session={session} />}

          {!minimal && executor === 'kimi' && nativeModeOption && (
            <NativeOptionDrop
              option={nativeModeOption}
              role="mode"
              disabled={disabled || !onSetNativeConfig}
              onChange={value => setNativeConfigValue(nativeModeOption.id, value)}
            />
          )}

          {/* Permission mode stays beside Send for Claude and Codex. */}
          {!minimal && cliExecutor && (
            <>
              <button
                ref={approvalDrop.btnRef}
                type="button"
                className={`composer-opt cmp-approval-btn${approvalRisky ? ' risky' : ''}${approvalDrop.open ? ' open' : ''}`}
                title={t('composer.approval.title')}
                onClick={() => approvalDrop.setOpen(o => !o)}
              >
                <span className="name">
                  {cliExecutor === 'claude' && oneShotBypass
                    ? t('composer.bypass.button')
                    : composerModeLabel(cliExecutor, approvalMode ?? 'ask', proxyModes, t)}
                </span>
                <span className="caret cmp-caret" aria-hidden="true">▾</span>
              </button>
              {approvalDrop.open && approvalDrop.pos && createPortal(
                <div
                  ref={approvalDrop.popRef}
                  className="popover approval-pop"
                  role="dialog"
                  style={{ left: approvalDrop.pos.left, bottom: approvalDrop.pos.bottom }}
                >
                  <div className="mp-section-head">
                    <span className="mp-section-title">
                      {cliExecutor === 'codex'
                        ? t('composer.approval.section')
                        : t('composer.mode.title')}
                    </span>
                  </div>
                  <div className="mp-list">
                    {modeOptions.map(opt => {
                      const active = !oneShotBypass && approvalMode === opt.mode;
                      const title = opt.titleKey ? t(opt.titleKey) : (opt.label ?? opt.key);
                      const hint = opt.descKey
                        ? t(opt.descKey)
                        : (!opt.titleKey && opt.description ? opt.description : null);
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          className={`mp-row${active ? ' active' : ''}`}
                          onClick={() => {
                            setOneShotBypass(false);
                            setMode(opt.mode);
                            approvalDrop.setOpen(false);
                          }}
                        >
                          <span className="mp-check">{active ? '✓' : ''}</span>
                          <span className="mp-row-body">
                            <span className="mp-row-title">{title}</span>
                            {hint && (
                              <span className="mp-row-hint">{hint}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    {cliExecutor === 'claude' && (
                      <button
                        type="button"
                        className={`mp-row danger-option${oneShotBypass ? ' active' : ''}`}
                        onClick={() => {
                          setOneShotBypass(active => !active);
                          approvalDrop.setOpen(false);
                        }}
                      >
                        <span className="mp-check">{oneShotBypass ? '✓' : ''}</span>
                        <span className="mp-row-body">
                          <span className="mp-row-title">{t('composer.bypass.button')}</span>
                          <span className="mp-row-hint">{t('composer.bypass.title')}</span>
                        </span>
                      </button>
                    )}
                  </div>
                </div>,
                document.body
              )}
            </>
          )}

          {/* Attach files — plus glyph (VS Code style). Hidden in minimal
              (bare textarea variant, no attachment pipeline). */}
          {!minimal && (
            <button
              type="button"
              className={`composer-act${pendingFiles.length > 0 ? ' active' : ''}`}
              title={t('composer.attachment.addFiles')}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('composer.attachment.addFiles')}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {/* Send / Stop */}
          {running ? (
            <button
              type="button"
              className="composer-act primary danger"
              onClick={onStop}
              disabled={stopping}
              title={stopping ? t('composer.stopping') : t('composer.stop.title')}
              aria-label={stopping ? t('composer.stopping') : t('composer.stop.button')}
            >
              {stopping ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="8" height="8" rx="1" />
                </svg>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="composer-act primary"
              disabled={!text.trim() && !canSendAttachmentOnly}
              onClick={submit}
              title={t('composer.send.button')}
              aria-label={t('composer.send.button')}
            >
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 7l9-4.5-3 9-2-3.5-4-1.5z" fill="currentColor" stroke="currentColor" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
