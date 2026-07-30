import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode, CcModelCapabilities, CodexModelCapabilities, Executor, MessageAttachment, NativeConfigChoice, NativeConfigOption, NativeConfigValue, Session, SlashCommand, SlashCommandSource, ThinkingEffort } from '@gian/shared';
import { loadNativeConfig, loadProxyModels, loadSessionSlashCommands, loadSlashCommands } from '../api.js';
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
  const p = loadProxyModels(executor)
    .then(list => {
      MODEL_CACHE.set(executor, list);
      MODEL_PROMISES.delete(executor);
      return list;
    })
    .catch(error => {
      // A transient host/proxy outage must not poison this executor's cache.
      // The mounted Composer handles the rejection and a later session open
      // can retry capability discovery.
      MODEL_PROMISES.delete(executor);
      throw error;
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

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}m`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function ContextUsageIndicator({ session }: { session: Session }) {
  const t = useT();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const used = typeof session.context_tokens_used === 'number'
    ? session.context_tokens_used
    : null;
  const capacity = typeof session.context_window_tokens === 'number'
    && session.context_window_tokens > 0
    ? session.context_window_tokens
    : null;
  const hasRatio = used !== null && capacity !== null;
  const percent = hasRatio
    ? Math.round(Math.min(1, Math.max(0, used / capacity)) * 100)
    : null;
  const recalculating = used === null && Boolean(session.context_usage_updated_at);
  const conversationVisible = session.conversation_usage_complete === 1
    && typeof session.conversation_total_tokens === 'number';

  const showTooltip = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const preferred = rect.left + rect.width / 2;
    setTooltipPosition({
      left: Math.min(Math.max(preferred, 132), window.innerWidth - 132),
      top: rect.top - 8,
    });
  };

  const ringStyle = {
    '--context-progress': `${(percent ?? 0) * 3.6}deg`,
  } as CSSProperties;
  const stateClass = recalculating
    ? ' is-recalculating'
    : percent !== null && percent >= 90
      ? ' is-danger'
      : percent !== null && percent >= 75
        ? ' is-warning'
        : percent === null
          ? ' is-unknown'
          : '';
  const ariaLabel = percent === null
    ? t(recalculating ? 'composer.context.recalculating' : 'composer.context.afterResponse')
    : `${t('composer.context.title')}: ${percent}% ${t('composer.context.used')}`;

  return (
    <>
      <span
        ref={anchorRef}
        className={`context-usage-anchor${stateClass}`}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltipPosition(null)}
        onFocus={showTooltip}
        onBlur={() => setTooltipPosition(null)}
      >
        <span className="context-usage-ring" style={ringStyle} aria-hidden="true" />
      </span>
      {tooltipPosition && createPortal(
        <div
          className="context-usage-tooltip"
          role="tooltip"
          style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
        >
          <div className="context-usage-tooltip-title">{t('composer.context.title')}</div>
          {hasRatio && percent !== null && (
            <>
              <div className="context-usage-tooltip-primary">
                {percent}% {t('composer.context.used')} ({100 - percent}% {t('composer.context.left')})
              </div>
              <div className="context-usage-tooltip-detail">
                {formatTokenCount(used)} / {formatTokenCount(capacity)} {t('composer.context.tokensUsed')}
              </div>
            </>
          )}
          {!hasRatio && used !== null && (
            <div className="context-usage-tooltip-detail">
              {formatTokenCount(used)} {t('composer.context.tokensUsed')}
            </div>
          )}
          {used === null && (
            <div className="context-usage-tooltip-state">
              {t(recalculating ? 'composer.context.recalculating' : 'composer.context.afterResponse')}
            </div>
          )}
          {conversationVisible && (
            <div className="context-usage-conversation">
              <div className="context-usage-tooltip-title">{t('composer.context.conversationTotal')}</div>
              <div className="context-usage-tooltip-primary">
                {session.conversation_total_tokens!.toLocaleString()} {t('composer.context.tokens')}
              </div>
              <div className="context-usage-breakdown">
                <span>{t('composer.context.input')} {(session.conversation_input_tokens ?? 0).toLocaleString()}</span>
                <span>{t('composer.context.output')} {(session.conversation_output_tokens ?? 0).toLocaleString()}</span>
                {(session.conversation_cached_input_tokens ?? 0) > 0 && (
                  <span>{t('composer.context.cached')} {(session.conversation_cached_input_tokens ?? 0).toLocaleString()}</span>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/** A concrete Claude id like `claude-opus-4-8` (synced live from a TTY
 *  transcript) maps to its `opus`/`sonnet`/`haiku` alias family so the static
 *  alias menu can still highlight the matching row. Returns the input
 *  unchanged when it isn't a recognizable concrete claude id. */
function claudeModelFamily(id: string): string {
  return /^claude-(opus|sonnet|haiku)\b/.exec(id)?.[1] ?? id;
}

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

function BulbIcon() {
  return (
    <svg
      className="cmp-bulb"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5Z" />
    </svg>
  );
}

function ExecutorMark({ executor }: { executor: Executor }) {
  return <span className={`cmp-executor-mark ${executor}`} aria-hidden="true" />;
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
  const p = loadSlashCommands(executor, workspaceId)
    .then(list => {
      SLASH_CACHE.set(key, list);
      SLASH_PROMISES.delete(key);
      return list;
    })
    .catch(error => {
      SLASH_PROMISES.delete(key);
      throw error;
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

/** A bottom-anchored ("up-drop") popover: a trigger button and a portaled panel
 *  that opens upward from the button (composer sits at the bottom of the
 *  viewport). Mirrors the model popover's positioning + click-outside. Used for
 *  the codex Thinking and Approval up-drops. */
function useUpDrop(popoverWidth: number) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const fittedWidth = Math.min(popoverWidth, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - fittedWidth - 8));
    setPos({ left, bottom: window.innerHeight - rect.top + 6 });
  }, [open, popoverWidth]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return { open, setOpen, pos, btnRef, popRef };
}

/** Codex permission presets. Each is sent as a per-turn native policy. */
const CODEX_APPROVALS: Array<{
  key: string;
  mode: ApprovalMode;
  titleKey: string;
  descKey: string;
}> = [
  { key: 'ask', mode: 'ask', titleKey: 'composer.approval.ask.title', descKey: 'composer.approval.ask.desc' },
  { key: 'approve', mode: 'auto', titleKey: 'composer.approval.approve.title', descKey: 'composer.approval.approve.desc' },
  { key: 'full', mode: 'full-access', titleKey: 'composer.approval.full.title', descKey: 'composer.approval.full.desc' },
  { key: 'custom', mode: 'custom', titleKey: 'composer.approval.custom.title', descKey: 'composer.approval.custom.desc' },
];

/** i18n key for the codex approval button's current-selection label. Legacy
 *  'plan' (no longer offered for codex) falls back to a generic label. */
function codexApprovalLabelKey(mode: ApprovalMode): string {
  switch (mode) {
    case 'ask': return 'composer.approval.ask.title';
    case 'auto': return 'composer.approval.approve.title';
    case 'custom': return 'composer.approval.custom.title';
    case 'full-access': return 'composer.approval.full.title';
    default: return 'composer.approval.title';
  }
}

/** Codex's own display names for reasoning-effort levels (the API values are
 *  minimal/low/medium/high/xhigh; Codex shows Light/Medium/High/Extra High).
 *  Plain text, no icons, no "Default" — Codex always has one concrete level. */
const CODEX_EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};
function codexEffortLabel(level: ThinkingEffort | null): string {
  if (!level) return '';
  return CODEX_EFFORT_LABELS[level] ?? level;
}

function effortLabel(executor: Exclude<Executor, 'kimi'>, level: ThinkingEffort | null): string {
  if (!level) return '';
  return executor === 'codex'
    ? codexEffortLabel(level)
    : level.replace(/(^|[-_])(\w)/g, (_match, separator: string, letter: string) =>
      `${separator ? ' ' : ''}${letter.toUpperCase()}`);
}

type NativeOptionRole = 'model' | 'effort' | 'mode';

function nativeOptionRole(option: NativeConfigOption): NativeOptionRole | null {
  const category = option.category?.trim().toLowerCase();
  const id = option.id.trim().toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    category === 'thought_level'
    || category === 'thought'
    || category === 'thinking'
    || category === 'effort'
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'effort';
  if (category === 'mode' || id === 'mode') return 'mode';
  return null;
}

function nativeChoiceDisplayLabel(
  role: NativeOptionRole,
  choice: NativeConfigChoice,
): string {
  const value = String(choice.value ?? '').toLowerCase();
  if (role === 'mode' && (value === 'plan' || value === 'auto' || value === 'yolo')) {
    return value;
  }
  return choice.label;
}

function nativeChoiceLabel(option: NativeConfigOption, role: NativeOptionRole): string {
  const current = option.choices?.find(choice =>
    String(choice.value ?? '') === String(option.currentValue ?? ''));
  return current
    ? nativeChoiceDisplayLabel(role, current)
    : String(option.currentValue ?? option.name);
}

function NativeOptionDrop({
  option,
  role,
  disabled,
  onChange,
}: {
  option: NativeConfigOption;
  role: NativeOptionRole;
  disabled: boolean;
  onChange: (value: NativeConfigValue) => void;
}) {
  const drop = useUpDrop(260);
  const currentLabel = nativeChoiceLabel(option, role);
  return (
    <>
      <button
        ref={drop.btnRef}
        type="button"
        className={`composer-opt cmp-native-${role}${drop.open ? ' open' : ''}`}
        title={option.description ?? option.name}
        disabled={disabled}
        onClick={() => drop.setOpen(open => !open)}
      >
        {role === 'model' && <ExecutorMark executor="kimi" />}
        {role === 'effort' && <BulbIcon />}
        <span className="name">{currentLabel}</span>
        <span className="caret cmp-caret" aria-hidden="true">▾</span>
      </button>
      {drop.open && drop.pos && createPortal(
        <div
          ref={drop.popRef}
          className={`popover native-option-pop native-option-${role}-pop`}
          role="dialog"
          style={{ left: drop.pos.left, bottom: drop.pos.bottom }}
        >
          <div className="mp-section-head">
            <span className="mp-section-title">{option.name}</span>
          </div>
          <div className="mp-list">
            {(option.choices ?? []).map(choice => {
              const active = String(choice.value ?? '') === String(option.currentValue ?? '');
              return (
                <button
                  key={String(choice.value)}
                  type="button"
                  className={`mp-row${active ? ' active' : ''}`}
                  onClick={() => {
                    onChange(choice.value);
                    drop.setOpen(false);
                  }}
                >
                  <span className="mp-check">{active ? '✓' : ''}</span>
                  <span className="mp-row-body">
                    <span className="mp-row-title">
                      {nativeChoiceDisplayLabel(role, choice)}
                    </span>
                    {choice.description && <span className="mp-row-hint">{choice.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function Composer({
  session,
  onSend, onSendSkill, onStop, onQueueAdd, onSetMode, onSetModel, onSetEffort,
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
   *  controls down to a bare textarea + Send/Stop. Used by the read-only Task
   *  Manager composer: the Manager is a fixed-config Codex session (forced model/policy), so those
   *  affordances would expose abilities it doesn't have. The draft-persistence,
   *  Send→Stop toggle, width and keyboard handling are all kept identical to a
   *  normal session composer. */
  variant?: 'full' | 'minimal';
  /** Override the idle placeholder text (defaults to `composer.placeholder.idle`). */
  placeholder?: string;
}) {
  const t = useT();
  const minimal = variant === 'minimal';
  const legacyExecutor = executor === 'kimi' ? null : executor;
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
    () => legacyExecutor
      ? (SLASH_CACHE.get(slashCacheKey(legacyExecutor, workspaceId)) ?? [])
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
    legacyExecutor ? (MODEL_CACHE.get(legacyExecutor) ?? []) : [],
  );
  const sessionNativeOptions = session.native_config_options ?? [];
  const [nativeOptions, setNativeOptions] = useState(sessionNativeOptions);

  // Fetch model list lazily per executor; cached.
  useEffect(() => {
    if (!legacyExecutor) {
      setModels([]);
      return;
    }
    if (MODEL_CACHE.has(legacyExecutor)) {
      setModels(MODEL_CACHE.get(legacyExecutor)!);
      return;
    }
    let alive = true;
    void fetchModelsCached(legacyExecutor)
      .then(list => { if (alive) setModels(list); })
      .catch(() => {
        // Keep rendering the session with its persisted model/effort. The
        // capability menu can retry the next time this executor is mounted.
        if (alive) setModels([]);
      });
    return () => { alive = false; };
  }, [legacyExecutor]);

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
    const key = slashCacheKey(executor, workspaceId);
    const cached = SLASH_CACHE.get(key);
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
    ?? (models.length > 0 && legacyExecutor ? defaultModel(models, legacyExecutor) : '');
  // Fall back to the default (or first) entry when the active model isn't in
  // the menu — e.g. a concrete id like `claude-opus-4-8` synced from a TTY hook
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
  // Pending file attachments — UI only; not yet sent with messages
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
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

  function setMode(mode: ApprovalMode) {
    onSetMode(mode, mode === 'auto' ? (turns > 1 ? turns : 1) : undefined);
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
    // ⌘/Ctrl+Enter is the global "send now" shortcut — let it bubble to the
    // document handler instead of submitting/queuing the current draft here.
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
                <img className="att-thumb" src={f.previewUrl} alt="" />
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
          {legacyExecutor && (
            <>
              <button
                ref={thinkDrop.btnRef}
                type="button"
                className={`composer-opt cmp-think-btn${thinkDrop.open ? ' open' : ''}`}
                title={t('composer.reasoning.effort')}
                onClick={() => thinkDrop.setOpen(o => !o)}
              >
                <BulbIcon />
                <span className="name">{effortLabel(legacyExecutor, thinkLevel)}</span>
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
                            <span className="mp-row-title">{effortLabel(legacyExecutor, lvl)}</span>
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

          {/* Turns stepper hidden — multi-turn auto-job UI deferred (PR5/#6).
              State + handlers retained so re-enabling is one toggle. */}
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

          {/* Permission mode stays beside Send for every legacy CLI. */}
          {!minimal && legacyExecutor && (
            <>
              <button
                ref={approvalDrop.btnRef}
                type="button"
                className={`composer-opt cmp-approval-btn${approvalDrop.open ? ' open' : ''}`}
                title={t('composer.approval.title')}
                onClick={() => approvalDrop.setOpen(o => !o)}
              >
                <span className="name">
                  {legacyExecutor === 'codex'
                    ? t(codexApprovalLabelKey(approvalMode ?? 'ask'))
                    : oneShotBypass
                      ? t('composer.bypass.button')
                      : t(`mode.${approvalMode ?? 'ask'}`)}
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
                      {legacyExecutor === 'codex'
                        ? t('composer.approval.section')
                        : t('composer.mode.title')}
                    </span>
                  </div>
                  <div className="mp-list">
                    {(legacyExecutor === 'codex'
                      ? CODEX_APPROVALS
                      : [
                          { key: 'plan', mode: 'plan' as const, titleKey: 'mode.plan' },
                          { key: 'ask', mode: 'ask' as const, titleKey: 'mode.ask' },
                          { key: 'auto', mode: 'auto' as const, titleKey: 'mode.auto' },
                        ]).map(opt => {
                      const active = !oneShotBypass && approvalMode === opt.mode;
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
                            <span className="mp-row-title">{t(opt.titleKey)}</span>
                            {'descKey' in opt && opt.descKey && (
                              <span className="mp-row-hint">{t(opt.descKey)}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    {legacyExecutor === 'claude' && (
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

          {/* Attach files — plus glyph (VS Code style) — picker not supported in v1.
              Hidden in minimal: the Manager composer has no attachment pipeline. */}
          {!minimal && (
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
