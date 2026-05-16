import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode, CcModelCapabilities, CodexModelCapabilities, Session, SlashCommand, SlashCommandSource, ThinkingEffort } from '@gian/shared';
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

interface PendingFile {
  name: string;
  size: number;
  /** Human-readable size, e.g. "3.2 MB" */
  sizeLabel: string;
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
  return def?.model ?? (executor === 'codex' ? 'gpt-5-codex' : 'claude-sonnet-4-6');
}

function modelLabel(models: ProxyModel[], id: string): string {
  return models.find(m => m.model === id)?.displayName ?? id;
}

const THINK_LEVELS: ThinkingEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'];
const THINK_INDEX: Record<ThinkingEffort, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, max: 5, xhigh: 5,
};

function supportedEfforts(model: ProxyModel | undefined): ThinkingEffort[] {
  if (!model) return THINK_LEVELS;
  if ('supportedEfforts' in model) return model.supportedEfforts;
  if ('supportedThinking' in model) {
    return model.supportedThinking.map(e => e === null ? 'off' : e) as ThinkingEffort[];
  }
  return THINK_LEVELS;
}

function defaultEffort(model: ProxyModel | undefined): ThinkingEffort {
  if (!model) return 'medium';
  if ('defaultEffort' in model) return model.defaultEffort;
  if ('defaultThinking' in model) return (model.defaultThinking ?? 'off') as ThinkingEffort;
  return 'medium';
}

function ThinkBars({ level }: { level: ThinkingEffort }) {
  const n = THINK_INDEX[level];
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
const SOURCE_LABELS: Record<SlashCommandSource, string> = {
  builtin: 'BUILTIN',
  project: 'PROJECT (.claude/commands)',
  user: 'USER (~/.claude/commands)',
};

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
  onSend, onSendSkill, onStop, onQueueAdd, onSetMode, onSetModel, onSetEffort,
  disabled, executor,
  workspaceId,
  footer,
}: {
  session: Session;
  onSend: (text: string, opts?: { oneShotBypass?: boolean }) => void;
  /** Dispatch a skill invocation directly (used for codex user/project skills
   *  — bypasses the input box so the skill runs as a structured input item
   *  rather than being sent as text). */
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onQueueAdd: (text: string) => void;
  onSetMode: (mode: ApprovalMode, turns?: number) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  disabled: boolean;
  executor: 'claude' | 'codex';
  workspaceId?: string;
  footer?: import('react').ReactNode;
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
  const currentModelMeta = models.find(m => m.model === currentModel);
  const thinkLevel: ThinkingEffort = session.thinking_effort ?? defaultEffort(currentModelMeta);
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
    const trimmed = text.trim();
    if (!trimmed) return;
    if (disabled) {
      onQueueAdd(trimmed);
    } else {
      onSend(trimmed, oneShotBypass ? { oneShotBypass: true } : undefined);
      // Bypass is single-turn: clear immediately after dispatch so the next
      // send falls back to the session's stored approval_mode.
      if (oneShotBypass) setOneShotBypass(false);
    }
    setText('');
  }

  function setMode(mode: ApprovalMode) {
    onSetMode(mode, mode === 'auto' ? (turns > 1 ? turns : 1) : undefined);
  }

  function adjustTurns(delta: number) {
    const next = Math.max(1, turns + delta);
    onSetMode('auto', next);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    const valid = chosen.filter(f => f.size <= MAX_FILE_BYTES);
    setPendingFiles(prev => {
      const existing = new Set(prev.map(p => p.name));
      const added = valid
        .filter(f => !existing.has(f.name))
        .map(f => ({ name: f.name, size: f.size, sizeLabel: fmtBytes(f.size) }));
      return [...prev, ...added];
    });
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }

  function removeFile(name: string) {
    setPendingFiles(prev => prev.filter(f => f.name !== name));
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
            <span>Bypass mode — all actions auto-approved</span>
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
            placeholder={disabled ? t('composer.placeholder.busy') : t('composer.placeholder.idle')}
          />
        </div>

        {/* Pending attachment chips */}
        {pendingFiles.length > 0 && (
          <div className="cmp-attach-chips">
            {pendingFiles.map(f => (
              <span key={f.name} className="cmp-attach-chip">
                <svg className="cmp-attach-chip-ico" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                  <path d="M10 5.5L5.5 10A3 3 0 012 6.5L7 1.5a2 2 0 013 3L4.5 10A1 1 0 013 8.5l5-5" />
                </svg>
                <span className="cmp-attach-chip-name" title={f.name}>{f.name}</span>
                <span className="cmp-attach-chip-size">{f.sizeLabel}</span>
                <button
                  type="button"
                  className="cmp-attach-chip-rm"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f.name)}
                >×</button>
              </span>
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
                <span className="cmp-slash-desc">Loading…</span>
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
                  <div className="cmp-slash-section">{SOURCE_LABELS[group.source]}</div>
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
          {/* Model picker — opens custom model+thinking popover */}
          <div className="composer-model">
          <button
            ref={modelBtnRef}
            type="button"
            className="composer-opt cmp-model-wrap"
            title={t('composer.model.title')}
            onClick={() => setModelPopOpen(v => !v)}
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
                  <span className="mp-section-title">Model</span>
                  <span className="mp-section-hint">{executor}</span>
                </div>
                <div className="mp-list">
                  {models.length === 0 && (
                    <div className="mp-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>Loading…</div>
                  )}
                  {models.filter(m => !m.hidden).map(m => {
                    const active = m.model === activeModel;
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
                  <span className="mp-section-title">Reasoning effort</span>
                </div>
                <div className="mp-think-grid">
                  {supportedEfforts(currentModelMeta).map(lvl => (
                    <button
                      key={lvl}
                      type="button"
                      className={`mp-think${thinkLevel === lvl ? ' active' : ''}`}
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
              title="Bypass approvals (this turn only)"
              aria-pressed={oneShotBypass}
              onClick={() => setOneShotBypass(v => !v)}
            >
              <span className="cmode-warn" aria-hidden="true">⚠</span>
              Bypass
            </button>
          </div>
          {oneShotBypass && (
            <span className="bypass-hint" role="status">⚠ next turn skips approvals</span>
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

          <span className="spacer" />

          {/* Slash command — framed [/] glyph */}
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

          {/* Attach files — plus glyph (VS Code style) */}
          <button
            type="button"
            className={`composer-act${pendingFiles.length > 0 ? ' active' : ''}`}
            title="Attach files (Cmd+V to paste)"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          {/* Send / Stop */}
          {disabled ? (
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
              disabled={!text.trim()}
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
