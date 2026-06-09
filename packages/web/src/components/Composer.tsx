import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode, CcModelCapabilities, CodexModelCapabilities, MessageAttachment, RemoteControlState, Session, SlashCommand, SlashCommandSource, ThinkingEffort } from '@gian/shared';
import { loadProxyModels, loadSlashCommands } from '../api.js';
import { useT } from '../i18n/index.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Per-session unsent draft. localStorage key prefix; bump the version
 *  suffix if the schema ever needs to change. */
const DRAFT_KEY_PREFIX = 'gian.composer.draft.v1.';
const draftKey = (sessionId: string) => `${DRAFT_KEY_PREFIX}${sessionId}`;
function readDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(sessionId), text);
    else localStorage.removeItem(draftKey(sessionId));
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
  const next = existing ? `${existing}\n\n${text}` : text;
  writeDraft(sessionId, next);
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

type ProxyModel = CcModelCapabilities | CodexModelCapabilities;

/** Cached per executor across Composer instances — capabilities don't
 *  change at runtime so a single fetch is enough. */
const MODEL_CACHE: Map<'claude' | 'codex', ProxyModel[]> = new Map();
const MODEL_PROMISES: Map<'claude' | 'codex', Promise<ProxyModel[]>> = new Map();

function fetchModelsCached(executor: 'claude' | 'codex'): Promise<ProxyModel[]> {
  const hit = MODEL_CACHE.get(executor);
  if (hit) return Promise.resolve(hit);
  const inflight = MODEL_PROMISES.get(executor);
  if (inflight) return inflight;
  const p = loadProxyModels(executor).then(list => {
    MODEL_CACHE.set(executor, list);
    MODEL_PROMISES.delete(executor);
    return list;
  });
  MODEL_PROMISES.set(executor, p);
  return p;
}

function defaultModel(models: ProxyModel[], executor: 'claude' | 'codex'): string {
  const def = models.find(m => m.isDefault) ?? models[0];
  return def?.model ?? (executor === 'codex' ? 'gpt-5-codex' : '');
}

function modelLabel(models: ProxyModel[], id: string): string {
  return models.find(m => m.model === id)?.displayName ?? id;
}

/** A concrete Claude id like `claude-opus-4-8` (synced live from a TTY
 *  transcript) maps to its `opus`/`sonnet`/`haiku` alias family so the static
 *  alias menu can still highlight the matching row. Returns the input
 *  unchanged when it isn't a recognizable concrete claude id. */
function claudeModelFamily(id: string): string {
  return /^claude-(opus|sonnet|haiku)\b/.exec(id)?.[1] ?? id;
}

const THINK_INDEX: Record<string, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, max: 5, xhigh: 5,
};

function supportedEfforts(model: ProxyModel | undefined): ThinkingEffort[] {
  if (!model) return [];
  if ('supportedEfforts' in model) return model.supportedEfforts;
  if ('supportedThinking' in model) {
    return model.supportedThinking.map(e => e === null ? 'off' : e) as ThinkingEffort[];
  }
  return [];
}

function defaultEffort(model: ProxyModel | undefined): ThinkingEffort | null {
  if (!model) return null;
  if ('defaultEffort' in model) return model.defaultEffort;
  if ('defaultThinking' in model) return (model.defaultThinking ?? 'off') as ThinkingEffort;
  return null;
}

function ThinkBars({ level }: { level: ThinkingEffort | null }) {
  const n = level ? (THINK_INDEX[level] ?? 0) : 0;
  return (
    <span className="think-bars" data-level={level}>
      <i className={n >= 1 ? 'on' : ''} />
      <i className={n >= 2 ? 'on' : ''} />
      <i className={n >= 3 ? 'on' : ''} />
    </span>
  );
}

/** Module-scope cache keyed by `${executor}:${workspaceId ?? '_'}` */
const SLASH_CACHE = new Map<string, SlashCommand[]>();
const SLASH_PROMISES = new Map<string, Promise<SlashCommand[]>>();

function slashCacheKey(executor: 'claude' | 'codex', workspaceId: string | undefined): string {
  return `${executor}:${workspaceId ?? '_'}`;
}

function fetchSlashCached(executor: 'claude' | 'codex', workspaceId?: string): Promise<SlashCommand[]> {
  const key = slashCacheKey(executor, workspaceId);
  const hit = SLASH_CACHE.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = SLASH_PROMISES.get(key);
  if (inflight) return inflight;
  const p = loadSlashCommands(executor, workspaceId).then(list => {
    SLASH_CACHE.set(key, list);
    SLASH_PROMISES.delete(key);
    return list;
  });
  SLASH_PROMISES.set(key, p);
  return p;
}

const SOURCE_ORDER: SlashCommandSource[] = ['builtin', 'project', 'user'];
function slashFilterGrouped(
  commands: SlashCommand[],
  prefix: string,
): Array<{ source: SlashCommandSource; items: SlashCommand[] }> {
  const lc = prefix && prefix !== '/' ? prefix.toLowerCase() : null;
  const groups: Array<{ source: SlashCommandSource; items: SlashCommand[] }> = [];
  for (const source of SOURCE_ORDER) {
    let items = commands.filter(c => c.source === source);
    if (lc) items = items.filter(c => c.name.toLowerCase().startsWith(lc));
    if (items.length > 0) groups.push({ source, items });
  }
  return groups;
}

/** Flat list of all filtered commands (for keyboard nav index tracking). */
function flatFiltered(groups: Array<{ source: SlashCommandSource; items: SlashCommand[] }>): SlashCommand[] {
  return groups.flatMap(g => g.items);
}

export function Composer({
  session,
  onSend, onSendSkill, onStop, onQueueAdd, onSetMode, onSetModel, onSetEffort, onJumpToCli,
  disabled, running, executor,
  workspaceId,
  footer,
  armedRemote = false,
  onRequestRemote,
  onCancelRemote,
  remoteControl,
  onToggleRemoteControl,
  disabledSubmitBehavior = 'queue',
}: {
  session: Session;
  onSend: (
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      /** Uploaded images for this turn. App owns the `previewUrl`s from
       *  this point — Composer must NOT revoke them; the optimistic echo
       *  reuses them as the `<img src>` until the server confirms with
       *  permanent URLs. */
      attachments?: Array<{
        path: string;
        name: string;
        mime: string;
        previewUrl: string;
      }>;
    },
  ) => void;
  /** Dispatch a skill invocation directly (used for codex user/project skills
   *  — bypasses the input box so the skill runs as a structured input item
   *  rather than being sent as text). */
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onQueueAdd: (text: string) => void;
  onSetMode: (mode: ApprovalMode, turns?: number) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  /** TTY only: jump to the CLI surface. In TTY, model/effort/mode are
   *  display-only — clicking them sends the user to the CLI to change them. */
  onJumpToCli?: () => void;
  disabled: boolean;
  /** A turn is actually in flight — drives the Send→Stop toggle. Distinct
   *  from `disabled`, which also covers lock-out / pending-question. */
  running: boolean;
  disabledSubmitBehavior?: 'queue' | 'block';
  executor: 'claude' | 'codex';
  workspaceId?: string;
  footer?: import('react').ReactNode;
  /** True when user clicked Remote while a turn was still running. The
   *  composer locks the textarea + send + queue-add and shows a banner.
   *  Only meaningful for claude sessions in structured mode. */
  armedRemote?: boolean;
  /** Called when the Remote icon button is clicked. Parent decides
   *  whether to fire the switch immediately or arm-for-later. */
  onRequestRemote?: () => void;
  /** Called when user clicks Cancel on the armed banner — or clicks the
   *  Remote button again while armed. */
  onCancelRemote?: () => void;
  /** Live Claude Remote Control state for this session when in TTY mode
   *  (undefined = never observed / off). Drives the in-TTY toggle's on/off
   *  appearance. */
  remoteControl?: RemoteControlState;
  /** Toggle Remote Control in TTY mode by sending `/remote-control` into the
   *  live PTY. Only meaningful when `session.runtime_mode === 'tty'`. */
  onToggleRemoteControl?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(() => readDraft(session.id));

  // Session swap: snapshot current draft under the OUTGOING session's key,
  // then load the INCOMING session's draft. We use the React-blessed
  // "adjust state during render" pattern so the textarea never paints the
  // outgoing draft against the incoming session id.
  const lastSessionRef = useRef(session.id);
  if (lastSessionRef.current !== session.id) {
    writeDraft(lastSessionRef.current, text);
    const incoming = readDraft(session.id);
    lastSessionRef.current = session.id;
    setText(incoming);
  }
  // Single-turn bypass: ⚡ button toggles. Cleared automatically after the
  // next send so it never persists across turns.
  const [oneShotBypass, setOneShotBypass] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(
    () => SLASH_CACHE.get(slashCacheKey(executor, workspaceId)) ?? [],
  );
  const [slashPopPos, setSlashPopPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [modelPopPos, setModelPopPos] = useState<{ left: number; bottom: number } | null>(null);
  const [models, setModels] = useState<ProxyModel[]>(MODEL_CACHE.get(executor) ?? []);

  // Fetch model list lazily per executor; cached.
  useEffect(() => {
    if (MODEL_CACHE.has(executor)) {
      setModels(MODEL_CACHE.get(executor)!);
      return;
    }
    let alive = true;
    void fetchModelsCached(executor).then(list => { if (alive) setModels(list); });
    return () => { alive = false; };
  }, [executor]);

  // Fetch slash commands lazily; keyed by (executor, workspaceId); cached.
  useEffect(() => {
    const key = slashCacheKey(executor, workspaceId);
    const cached = SLASH_CACHE.get(key);
    if (cached) {
      setSlashCommands(cached);
      return;
    }
    let alive = true;
    setSlashLoading(true);
    void fetchSlashCached(executor, workspaceId).then(list => {
      if (!alive) return;
      setSlashCommands(list);
      setSlashLoading(false);
    });
    return () => { alive = false; };
  }, [executor, workspaceId]);

  const currentModel = session.model ?? (models.length > 0 ? defaultModel(models, executor) : '');
  // Fall back to the default (or first) entry when the active model isn't in
  // the menu — e.g. a concrete id like `claude-opus-4-8` synced from a TTY hook
  // that the static alias list doesn't enumerate. Without this the effort grid
  // (keyed off the matched row's supportedEfforts) would render empty.
  const currentModelMeta = models.find(m => m.model === currentModel)
    ?? models.find(m => m.isDefault)
    ?? models[0];
  const explicitThinkLevel = session.thinking_effort;
  const thinkLevel = explicitThinkLevel ?? defaultEffort(currentModelMeta);
  // Pending file attachments — UI only; not yet sent with messages
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelPopRef = useRef<HTMLDivElement>(null);

  // Persist the draft on every text change so refreshes / accidental closes
  // don't lose unsent input. The session-swap render-time block above
  // already swaps `text` to the incoming session's draft, so this effect
  // always writes against the current session id.
  useEffect(() => {
    writeDraft(session.id, text);
  }, [session.id, text]);

  // External draft injection (Changes inspector → "commit / push / create PR"
  // prompts). The dispatcher has already written the appended draft to
  // localStorage; we just re-read it into the textarea and focus, caret at end.
  useEffect(() => {
    function onInject(e: Event) {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId !== session.id) return;
      setText(readDraft(session.id));
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
  const turns = session.turns;

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
    // Auto-open / auto-filter the popover based on what the user types.
    // Empty input is a no-op — the slash button click is what controls the
    // popover when there's no `/` text — otherwise an async slashCommands
    // refresh would close a manually-opened popover.
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
  }, [text, slashCommands]);

  useEffect(() => {
    if (!slashOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        slashBtnRef.current && !slashBtnRef.current.contains(e.target as Node) &&
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
    // Hard block while armed for Remote — the input is locked and the
    // banner is showing. User must Cancel before sending.
    if (armedRemote) return;
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
      previewUrl: f.previewUrl,
    }));
    if (disabled) {
      if (disabledSubmitBehavior === 'block') return;
      onQueueAdd(trimmed); // queue ignores images for now (out of scope)
      // Queue path doesn't transfer ownership — revoke previews now.
      for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    } else {
      const opts: {
        oneShotBypass?: true;
        attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
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

  // In TTY mode model/effort/mode are display-only — changing them needs the
  // CLI selector. Clicking any of these controls jumps to the CLI instead.
  const ttyDisplayOnly = session.runtime_mode === 'tty';

  function setMode(mode: ApprovalMode) {
    if (ttyDisplayOnly) { onJumpToCli?.(); return; }
    onSetMode(mode, mode === 'auto' ? (turns > 1 ? turns : 1) : undefined);
  }

  function adjustTurns(delta: number) {
    if (ttyDisplayOnly) { onJumpToCli?.(); return; }
    const next = Math.max(1, turns + delta);
    onSetMode('auto', next);
  }

  // Check if there are ready attachments (uploaded, no errors).
  const canSendAttachmentOnly = pendingFiles.some(f => !f.uploading && !f.error && f.path);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    const valid = chosen.filter(f => f.size <= MAX_FILE_BYTES);
    setPendingFiles(prev => {
      const existing = new Set(prev.map(p => p.name));
      const added = valid
        .filter(f => !existing.has(f.name))
        .map(f => ({
          id: crypto.randomUUID(),
          name: f.name,
          mime: f.type,
          size: f.size,
          sizeLabel: fmtBytes(f.size),
          previewUrl: URL.createObjectURL(f),
          path: null,
          uploading: false,
          error: undefined,
        }));
      return [...prev, ...added];
    });
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

  async function uploadOne(file: File): Promise<void> {
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
      uploading: true,
    };
    setPendingFiles(prev => [...prev, entry]);

    try {
      const { uploadAttachment } = await import('../api.js');
      const result = await uploadAttachment(session.id, file, file.name);
      setPendingFiles(prev =>
        prev.map(f => f.id === id ? { ...f, path: result.path, uploading: false } : f),
      );
    } catch (err) {
      setPendingFiles(prev =>
        prev.map(f => f.id === id ? { ...f, uploading: false, error: String(err) } : f),
      );
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        {/* Hidden file input — triggered by the paperclip button */}
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
          <div className="composer-bypass-banner">
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor"
                 strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2L1 22h22z" />
              <path d="M12 9v6" />
              <path d="M12 18v.01" />
            </svg>
            <span>{t('composer.bypass.banner')}</span>
          </div>
        )}

        {armedRemote && (
          <div className="composer-remote-banner" role="status" aria-live="polite">
            <span className="spinner" />
            <span>{t('composer.remote.banner')}</span>
            <button
              type="button"
              className="composer-remote-cancel"
              onClick={() => onCancelRemote?.()}
            >
              {t('composer.remote.cancel')}
            </button>
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
            disabled={armedRemote}
            placeholder={
              armedRemote
                ? t('composer.remote.waiting')
                : disabled
                  ? t('composer.placeholder.busy')
                  : t('composer.placeholder.idle')
            }
          />
        </div>

        {/* Pending attachment chips */}
        {pendingFiles.length > 0 && (
          <div className="composer-attachments">
            {pendingFiles.map(f => (
              <div key={f.id} className={`att-chip${f.error ? ' is-error' : ''}${f.uploading ? ' is-uploading' : ''}`}>
                <img className="att-thumb" src={f.previewUrl} alt="" />
                <span className="att-name" title={f.error ?? f.name}>{f.name}</span>
                <span className="att-size">{f.sizeLabel}</span>
                <button className="att-remove" type="button" onClick={() => removeFile(f.id)} aria-label={t('composer.attachment.remove')}>✕</button>
              </div>
            ))}
          </div>
        )}

        {slashOpen && slashPopPos && (slashLoading || filteredGroups.length > 0) && createPortal(
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
          {/* TTY: model / effort / mode are owned by the live CLI, so here they
              are a read-only readout, not interactive pills. A single
              "edit in CLI" link jumps to the terminal to change them. */}
          {ttyDisplayOnly && (
            <div className="composer-tty-meta">
              <span
                className="ctm-dot"
                style={{ background: executor === 'codex' ? 'var(--codex)' : 'var(--claude)' }}
                aria-hidden="true"
              />
              <span className="ctm-model">{modelLabel(models, activeModel) || activeModel}</span>
              <span className="ctm-effort">
                <ThinkBars level={thinkLevel} />
                {thinkLevel && <span className="ctm-effort-label">{thinkLevel}</span>}
              </span>
              <span className="ctm-mode">{t(`mode.${approvalMode}`)}</span>
              <button
                type="button"
                className="ctm-edit"
                onClick={() => onJumpToCli?.()}
                title={t('composer.tty.jumpToCli')}
              >
                {t('composer.tty.jumpToCli')} <span aria-hidden="true">↗</span>
              </button>
            </div>
          )}
          {!ttyDisplayOnly && (<>
          {/* Model picker — opens custom model+thinking popover */}
          <div className="composer-model">
          <button
            ref={modelBtnRef}
            type="button"
            className="composer-opt cmp-model-wrap"
            title={ttyDisplayOnly ? t('composer.model.titleTty') : t('composer.model.title')}
            onClick={() => { if (ttyDisplayOnly) { onJumpToCli?.(); return; } setModelPopOpen(v => !v); }}
          >
            <span
              style={{ width: 7, height: 7, borderRadius: 2, display: 'inline-block',
                       background: executor === 'codex' ? 'var(--codex)' : 'var(--claude)' }}
              aria-hidden="true"
            />
            <span className="name cmp-model">{modelLabel(models, activeModel) || activeModel}</span>
            <span className="caret cmp-caret" aria-hidden="true">▾</span>
            <span className="think cmp-think" aria-hidden="true">
              <ThinkBars level={thinkLevel} />
            </span>
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
                          {m.description && <span className="mp-row-hint">{m.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mp-section">
                <div className="mp-section-head">
                  <span className="mp-section-title">{t('composer.reasoning.effort')}</span>
                </div>
                <div className="mp-think-grid">
                  <button
                    type="button"
                    className={`mp-think${explicitThinkLevel === null ? ' active' : ''}`}
                    onClick={() => onSetEffort(null)}
                  >
                    <ThinkBars level={null} />
                    <span>{t('common.default')}</span>
                  </button>
                  {supportedEfforts(currentModelMeta).map(lvl => (
                    <button
                      key={lvl}
                      type="button"
                      className={`mp-think${explicitThinkLevel === lvl ? ' active' : ''}`}
                      onClick={() => onSetEffort(lvl)}
                    >
                      <ThinkBars level={lvl} />
                      <span style={{ textTransform: 'capitalize' }}>{lvl}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Approval mode — V2 segmented control */}
          <div
            className="composer-mode"
            role="tablist"
            aria-label="Approval mode"
            title={t('composer.mode.title')}
          >
            <button
              type="button"
              className={`cmode-item${approvalMode === 'plan' ? ' active' : ''}`}
              data-mode="plan"
              onClick={() => setMode('plan')}
            >
              {t('mode.plan')}
            </button>
            <button
              type="button"
              className={`cmode-item${approvalMode === 'ask' ? ' active' : ''}`}
              data-mode="ask"
              onClick={() => setMode('ask')}
            >
              {t('mode.ask')}
            </button>
            <button
              type="button"
              className={`cmode-item${approvalMode === 'auto' ? ' active' : ''}`}
              data-mode="auto"
              onClick={() => setMode('auto')}
            >
              {t('mode.auto')}
            </button>
            {/* Single-turn bypass — 4th segm. Toggling arms the next send
                with all approvals skipped (regardless of session.approval_mode);
                auto-clears after that turn. */}
            <button
              type="button"
              className={`cmode-item${oneShotBypass ? ' active' : ''}`}
              data-mode="bypass"
              title={t('composer.bypass.title')}
              aria-pressed={oneShotBypass}
              onClick={() => setOneShotBypass(v => !v)}
            >
              <span className="cmode-warn" aria-hidden="true">⚠</span>
              {t('composer.bypass.button')}
            </button>
          </div>
          {oneShotBypass && (
            <span className="bypass-hint" role="status">⚠ {t('composer.bypass.hint')}</span>
          )}

          {/* Plan-mode exit button — codex only. cc emits ExitPlanMode as a
              tool call which surfaces through the approval card flow. */}
          {approvalMode === 'plan' && session.executor === 'codex' && (
            <button
              type="button"
              className="cmode-exit-plan"
              title={t('plan.exit.help')}
              onClick={() => setMode('ask')}
            >
              {t('plan.exit.button')}
            </button>
          )}

          {/* Turns stepper hidden — multi-turn auto-job UI deferred (PR5/#6).
              State + handlers retained so re-enabling is one toggle. */}
          </>)}

          <span className="spacer" />

          {/* Remote control — Claude only.
              · Structured mode: click → switch to TTY w/ --remote-control
                (arms while a turn runs; banner + input lock; App.tsx fires the
                switch when the turn finishes).
              · TTY mode: click → toggle Remote Control live by sending
                `/remote-control` into the PTY; the antenna reflects the synced
                connection state (off / connecting / connected). */}
          {executor === 'claude' && session.runtime_mode === 'tty'
            ? onToggleRemoteControl && (
              <button
                type="button"
                className={`composer-act${remoteControl === 'connected' ? ' active' : ''}${remoteControl === 'connecting' ? ' is-connecting' : ''}`}
                title={
                  remoteControl === 'connected' ? t('composer.remote.on')
                  : remoteControl === 'connecting' ? t('composer.remote.connecting')
                  : t('composer.remote.off')
                }
                aria-label={t('composer.remote.control')}
                aria-pressed={remoteControl === 'connected'}
                onClick={() => onToggleRemoteControl()}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
                     strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12a7 7 0 0 1 14 0" />
                  <path d="M2 12a10 10 0 0 1 20 0" />
                  <circle cx="12" cy="18" r="1.6" fill="currentColor" />
                </svg>
              </button>
            )
            : executor === 'claude' && onRequestRemote && (
              <button
                type="button"
                className={`composer-act${armedRemote ? ' active' : ''}`}
                title={armedRemote
                  ? t('composer.remote.cancelSwitch')
                  : t('composer.remote.open')}
                aria-label={t('composer.remote.control')}
                aria-pressed={armedRemote}
                onClick={() => {
                  if (armedRemote) onCancelRemote?.();
                  else onRequestRemote();
                }}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
                     strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12a7 7 0 0 1 14 0" />
                  <path d="M2 12a10 10 0 0 1 20 0" />
                  <circle cx="12" cy="18" r="1.6" fill="currentColor" />
                </svg>
              </button>
            )}

          {/* Slash command — framed [/] glyph. Hidden in TTY: the live CLI
              has its own native slash UI, so this would only duplicate it. */}
          {!ttyDisplayOnly && (
            <button
              ref={slashBtnRef}
              type="button"
              className={`composer-act slash-box${slashOpen ? ' active' : ''}`}
              title={t('composer.slash.title')}
              onClick={() => {
                setSlashOpen(v => !v);
                setSlashIdx(0);
                ref.current?.focus();
              }}
            >
              <span className="glyph composer-slash-glyph">/</span>
            </button>
          )}

          {/* Attach files — plus glyph (VS Code style) — picker not supported in v1.
              Hidden in TTY (it's a no-op there; paste-to-upload still works). */}
          {!ttyDisplayOnly && (
            <button
              type="button"
              className={`composer-act${pendingFiles.length > 0 ? ' active' : ''}`}
              title={t('composer.attachment.pasteImagesHint')}
              disabled
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('composer.attachment.pasteImages')}
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
              title={t('composer.stop.title')}
              aria-label={t('composer.stop.button')}
            >
              <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer-act primary"
              disabled={armedRemote || (!text.trim() && !canSendAttachmentOnly)}
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
