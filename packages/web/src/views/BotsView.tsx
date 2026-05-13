import { useEffect, useMemo, useState } from 'react';
import type { Bot, BotExtra, BotMode, BotStatus, DiscordBotExtra, IMPlatform, Session, SlackBotExtra } from '@gian/shared';
import { createBot, deleteBot, toggleBot, updateBot } from '../api.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatCreated(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function CopyableInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  }
  return (
    <div className="bot-token-row">
      <input
        className="input bot-mono-input"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
      />
      <button
        type="button"
        className="btn xs ghost bot-token-show"
        disabled={!value}
        onClick={() => void copy()}
        tabIndex={-1}
        title="Copy to clipboard"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function TokenField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const hasValue = value.length > 0;
  return (
    <div className="bot-field">
      <label className="bot-field-label">
        <span>{label}</span>
        {hasValue && (
          <span className="bot-field-saved" title="Stored encrypted on the host">
            <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 6l2.2 2L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            saved
          </span>
        )}
      </label>
      <div className="bot-token-row">
        <input
          className="input bot-token-input"
          type={show ? 'text' : 'password'}
          value={value}
          placeholder={placeholder ?? '••••••••'}
          onChange={e => onChange(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn xs ghost bot-token-show"
          onClick={() => setShow(s => !s)}
          tabIndex={-1}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function emptyDiscordExtra(): DiscordBotExtra {
  return { token: '', application_id: '' };
}

function emptySlackExtra(): SlackBotExtra {
  return { bot_token: '', app_token: '', config_token: '', team_id: '', command_prefix: '/gian' };
}

function emptyExtra(platform: IMPlatform): BotExtra {
  return platform === 'discord' ? emptyDiscordExtra() : emptySlackExtra();
}

interface NewBotFormState {
  label: string;
  platform: IMPlatform;
  workspace_id: string;
  mode: BotMode;
  allowed_user_id: string;
  extra: BotExtra;
}

function NewBotForm({
  workspaces,
  onCancel,
  onCreated,
}: {
  workspaces: { id: string; name: string }[];
  onCancel: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<NewBotFormState>({
    label: '',
    platform: 'discord',
    workspace_id: workspaces[0]?.id ?? '',
    mode: 'read-only',
    allowed_user_id: '',
    extra: emptyDiscordExtra(),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patchForm(patch: Partial<NewBotFormState>) {
    setForm(prev => ({ ...prev, ...patch }));
  }

  function setPlatform(platform: IMPlatform) {
    patchForm({ platform, extra: emptyExtra(platform) });
  }

  function patchExtra(patch: Partial<DiscordBotExtra & SlackBotExtra>) {
    setForm(prev => ({ ...prev, extra: { ...prev.extra, ...patch } }));
  }

  async function submit() {
    if (!form.label.trim()) { setError(t('bots.form.error.label')); return; }
    setSaving(true);
    setError(null);
    const bot = await createBot({
      label: form.label.trim(),
      platform: form.platform,
      workspace_id: form.workspace_id || null,
      mode: form.mode,
      allowed_user_id: form.allowed_user_id.trim() || null,
      extra: form.extra,
    });
    setSaving(false);
    if (!bot) { setError(t('bots.form.error.failed')); return; }
    onCreated(bot);
  }

  const isDiscord = form.platform === 'discord';
  const de = form.extra as DiscordBotExtra;
  const se = form.extra as SlackBotExtra;

  return (
    <main className="main bot-new-main">
      <div className="bot-new-frame">
        <header className="bot-new-head">
          <div className="bot-new-head-l">
            <h1 className="bot-new-title">Create a bot</h1>
            <p className="bot-new-sub">Pair a Discord or Slack bot to a workspace.</p>
          </div>
          <button className="btn ghost sm" onClick={onCancel} disabled={saving}>
            {t('bots.form.cancel')}
          </button>
        </header>

        <div className="bot-new-platform-row">
          <span className="bot-new-platform-lbl">Platform</span>
          <div className="segm">
            {(['discord', 'slack'] as IMPlatform[]).map(p => (
              <button
                key={p}
                type="button"
                className={`segm-item${form.platform === p ? ' active' : ''}`}
                onClick={() => setPlatform(p)}
              >
                {p === 'discord' ? 'Discord' : 'Slack'}
              </button>
            ))}
          </div>
        </div>

        <section className="fcard bot-new-card">
          <div className="fcard-head">
            <span className="bot-new-card-num">01</span>
            <span className="bot-new-card-title">Identity</span>
            <span className="bot-new-card-hint">how you'll recognize this bot</span>
          </div>
          <div className="fcard-body">
            <div className="field">
              <div className="field-lbl">{t('bots.form.label.label')}</div>
              <input
                className="input"
                value={form.label}
                placeholder="My Discord Bot"
                onChange={e => patchForm({ label: e.target.value })}
                autoFocus
              />
            </div>
            <div className="field">
              <div className="field-lbl">
                <span>{t('bots.form.workspace.label')}</span>
                <span className="field-hint">optional · bind later</span>
              </div>
              <select
                className="select"
                value={form.workspace_id}
                onChange={e => patchForm({ workspace_id: e.target.value })}
              >
                <option value="">{t('bots.workspace.none')}</option>
                {workspaces.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="fcard bot-new-card">
          <div className="fcard-head">
            <span className="bot-new-card-num">02</span>
            <span className="bot-new-card-title">Connection</span>
            <span className="bot-new-card-hint">
              {isDiscord ? 'credentials from Discord Developer Portal' : 'credentials from Slack app config'}
            </span>
          </div>
          <div className="fcard-body">
            {isDiscord ? (
              <>
                <TokenField
                  label="Bot Token"
                  value={de.token ?? ''}
                  onChange={v => patchExtra({ token: v })}
                  placeholder="MTQyMDE2MjM2NDc4OTY..."
                />
                <div className="field">
                  <div className="field-lbl">Application ID</div>
                  <CopyableInput
                    value={de.application_id ?? ''}
                    placeholder="142016236478..."
                    onChange={v => patchExtra({ application_id: v })}
                  />
                </div>
              </>
            ) : (
              <>
                <TokenField
                  label="Bot Token"
                  value={se.bot_token ?? ''}
                  onChange={v => patchExtra({ bot_token: v })}
                  placeholder="xoxb-…"
                />
                <TokenField
                  label="App-level Token"
                  value={se.app_token ?? ''}
                  onChange={v => patchExtra({ app_token: v })}
                  placeholder="xapp-…"
                />
                <div className="field">
                  <div className="field-lbl">
                    <span>Command Prefix</span>
                    <span className="field-hint">how users invoke this bot</span>
                  </div>
                  <input
                    className="input bot-mono-input"
                    value={se.command_prefix ?? '/gian'}
                    placeholder="/gian"
                    onChange={e => patchExtra({ command_prefix: e.target.value })}
                  />
                </div>
              </>
            )}
          </div>
        </section>

        <section className="fcard bot-new-card">
          <div className="fcard-head">
            <span className="bot-new-card-num">03</span>
            <span className="bot-new-card-title">Permissions</span>
            <span className="bot-new-card-hint">who can talk to this bot, what it can do</span>
          </div>
          <div className="fcard-body">
            <div className="field">
              <div className="field-lbl">{t('bots.form.mode.label')}</div>
              <div className="segm">
                {(['read-only', 'full-control'] as BotMode[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`segm-item${form.mode === m ? ' active' : ''}`}
                    onClick={() => patchForm({ mode: m })}
                  >
                    {m === 'read-only' ? t('bots.mode.readonly') : t('bots.mode.fullcontrol')}
                  </button>
                ))}
              </div>
              <p className="field-hint bot-new-mode-hint">
                {form.mode === 'read-only'
                  ? t('bots.perm.mode.readonly.desc')
                  : t('bots.perm.mode.fullcontrol.desc')}
              </p>
            </div>
            <div className="field">
              <div className="field-lbl">
                <span>{t('bots.form.allowedusers.label')}</span>
                <span className="field-hint">comma-separated</span>
              </div>
              <input
                className="input bot-mono-input"
                value={form.allowed_user_id}
                placeholder="123456789, 987654321"
                onChange={e => patchForm({ allowed_user_id: e.target.value })}
              />
              <p className="field-hint">{t('bots.perm.allowedusers.hint')}</p>
            </div>
          </div>
        </section>

        {error && <p className="bot-error bot-new-error">{error}</p>}

        <footer className="bot-new-foot">
          <button className="btn ghost sm" onClick={onCancel} disabled={saving}>
            {t('bots.form.cancel')}
          </button>
          <button className="btn primary sm" onClick={() => void submit()} disabled={saving}>
            {saving ? t('bots.form.creating') : t('bots.form.create')}
          </button>
        </footer>
      </div>
    </main>
  );
}

function BotListPane({
  bots,
  selectedId,
  onSelect,
  onNewClick,
  workspaces,
}: {
  bots: Bot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewClick: () => void;
  workspaces: { id: string; name: string }[];
}) {
  const t = useT();
  return (
    <aside className="sidebar bots-rail">
      <div className="rail-head">
        <span className="rail-head-title">
          {t('bots.title')} <b>· {bots.length}</b>
        </span>
        <button className="btn-mini" onClick={onNewClick}>+ New</button>
      </div>
      <div className="rail-body">
        {bots.map(bot => {
          const status = bot.enabled ? bot.status : 'disabled';
          const initial = (bot.label || '?').charAt(0).toUpperCase();
          const wsName = workspaces.find(w => w.id === bot.workspace_id)?.name;
          return (
            <button
              type="button"
              key={bot.id}
              className={`bot-row${selectedId === bot.id ? ' active' : ''}`}
              onClick={() => onSelect(bot.id)}
            >
              <span className={`bot-platform-mark ${bot.platform}`}>{initial}</span>
              <span className="bot-row-info">
                <span className="bot-row-label">{bot.label}</span>
                <span className="bot-row-sub">
                  <span>{bot.platform}</span>
                  <span className="sep">·</span>
                  {wsName ? (
                    <span className="ws">{wsName}</span>
                  ) : (
                    <span className="ws unbound">unbound</span>
                  )}
                </span>
              </span>
              <span className="bot-row-meta">
                <span className={`status-dot ${status}`} title={status} />
              </span>
            </button>
          );
        })}
        {bots.length === 0 && (
          <p className="bot-list-empty">{t('bots.empty')}</p>
        )}
      </div>
    </aside>
  );
}


function BotDetail({
  bot,
  workspaces,
  sessions,
  onChange,
  onDeleted,
}: {
  bot: Bot | null;
  workspaces: { id: string; name: string }[];
  sessions: Session[];
  onChange: (updated: Bot) => void;
  onDeleted: () => void;
}) {
  const t = useT();

  // Form state — single source of truth for the entire dashboard.
  // We seed it from the bot prop and reset on bot change.
  const [form, setForm] = useState(() => ({
    label: bot?.label ?? '',
    workspace_id: bot?.workspace_id ?? '',
    mode: (bot?.mode ?? 'read-only') as BotMode,
    allowed_user_id: bot?.allowed_user_id ?? '',
    extra: (bot?.extra ?? {}) as BotExtra,
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  // Reset form when switching bots so we never carry edits across.
  useEffect(() => {
    if (!bot) return;
    setForm({
      label: bot.label,
      workspace_id: bot.workspace_id ?? '',
      mode: bot.mode,
      allowed_user_id: bot.allowed_user_id ?? '',
      extra: bot.extra,
    });
    setSaveError(null);
    setConfirmDelete(false);
    setDeleteError(null);
  }, [bot?.id, bot]);

  // Sessions linked to this bot's workspace — computed from the live session
  // list we receive from App. Excludes sessions in other workspaces.
  const sessionsLinked = useMemo(() => {
    if (!bot?.workspace_id) return 0;
    return sessions.filter(s => s.workspace_id === bot.workspace_id).length;
  }, [bot?.workspace_id, sessions]);

  if (!bot) {
    return (
      <main className="main spaces-detail-empty">
        <p>{t('bots.detail.empty')}</p>
      </main>
    );
  }

  const status = bot.enabled ? bot.status : 'disabled';
  const initial = (bot.label || '?').charAt(0).toUpperCase();
  const isDiscord = bot.platform === 'discord';
  const workspaceName = workspaces.find(w => w.id === bot.workspace_id)?.name ?? null;

  // Detect dirty state by deep-comparing the form to the bot snapshot.
  const dirty =
    form.label !== bot.label ||
    form.workspace_id !== (bot.workspace_id ?? '') ||
    form.mode !== bot.mode ||
    form.allowed_user_id !== (bot.allowed_user_id ?? '') ||
    JSON.stringify(form.extra) !== JSON.stringify(bot.extra);

  function patchExtra(patch: Partial<DiscordBotExtra & SlackBotExtra>) {
    setForm(prev => ({ ...prev, extra: { ...prev.extra, ...patch } }));
  }

  async function save() {
    if (!form.label.trim()) { setSaveError(t('bots.config.error.label')); return; }
    setSaving(true);
    setSaveError(null);
    const updated = await updateBot(bot!.id, {
      label: form.label.trim(),
      workspace_id: form.workspace_id || null,
      mode: form.mode,
      allowed_user_id: form.allowed_user_id.trim() || null,
      extra: form.extra,
    });
    setSaving(false);
    if (!updated) { setSaveError(t('bots.config.error.save')); return; }
    onChange(updated);
  }

  async function toggleEnabled() {
    if (togglingEnabled) return;
    setTogglingEnabled(true);
    const updated = await toggleBot(bot!.id);
    setTogglingEnabled(false);
    if (updated) onChange(updated);
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    setDeleteError(null);
    const ok = await deleteBot(bot!.id);
    setDeleting(false);
    if (!ok) { setDeleteError(t('bots.delete.error.failed')); return; }
    onDeleted();
  }

  const de = form.extra as DiscordBotExtra;
  const se = form.extra as SlackBotExtra;

  return (
    <main className="main bot-detail">
      {/* ===== Header ===== */}
      <header className="detail-head">
        <div className="detail-head-l">
          <span className={`detail-bot-mark ${bot.platform}`}>{initial}</span>
          <div className="detail-bot-info">
            <h1 className="detail-bot-name">{bot.label}</h1>
            <div className="detail-bot-sub">
              <span className={`platform-chip ${bot.platform}`}>{isDiscord ? 'Discord' : 'Slack'}</span>
              <span className="detail-bot-sub-sep">·</span>
              {workspaceName ? (
                <span>bound to <b>{workspaceName}</b></span>
              ) : (
                <span className="detail-bot-sub-dim">no workspace</span>
              )}
              <span className="detail-bot-sub-sep">·</span>
              <span>created {formatCreated(bot.created_at)}</span>
            </div>
          </div>
        </div>
        <div className="detail-head-r">
          <button
            type="button"
            className="enable-switch"
            data-on={bot.enabled === 1 ? 'true' : undefined}
            disabled={togglingEnabled}
            onClick={() => void toggleEnabled()}
            title={bot.enabled ? t('bots.toggle.disable') : t('bots.toggle.enable')}
          >
            <span className="enable-switch-lbl">{bot.enabled ? 'Enabled' : 'Disabled'}</span>
            <span className={`enable-switch-knob${bot.enabled ? ' on' : ''}`} />
          </button>
          <button
            className="btn sm primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
            title={dirty ? 'Save changes' : 'No changes'}
          >
            {saving ? t('bots.config.saving') : t('bots.config.save')}
          </button>
        </div>
      </header>

      {/* ===== Body ===== */}
      <div className="detail-body">
        {/* Stats strip — only render cards we actually have data for. */}
        <div className="cfg-stats bot-detail-stats">
          <div className="cfg-stat">
            <span className="cfg-stat-label">Status</span>
            <span className={`cfg-stat-value bot-detail-status bot-detail-status-${status}`}>
              <span className="bot-detail-status-dot" />
              {status}
            </span>
            <span className="cfg-stat-sub">
              {bot.last_error
                ? <span className="bot-detail-status-err" title={bot.last_error}>{bot.last_error}</span>
                : status === 'connected' ? 'gateway open' : status === 'disabled' ? 'forwarding paused' : '—'}
            </span>
          </div>
          {sessionsLinked > 0 && (
            <div className="cfg-stat">
              <span className="cfg-stat-label">Sessions linked</span>
              <span className="cfg-stat-value">{sessionsLinked}</span>
              <span className="cfg-stat-sub">in {workspaceName ?? 'workspace'}</span>
            </div>
          )}
          {bot.last_connected_at && (
            <div className="cfg-stat">
              <span className="cfg-stat-label">Last connected</span>
              <span className="cfg-stat-value-mono">{relTime(bot.last_connected_at)}</span>
              <span className="cfg-stat-sub">{new Date(bot.last_connected_at).toLocaleString()}</span>
            </div>
          )}
        </div>

        {saveError && <p className="bot-error bot-new-error">{saveError}</p>}

        {/* Connection + Routing — two-column on wide viewports. */}
        <div className="bot-detail-grid">

          <section className="cfg-card">
            <div className="cfg-card-head">
              <span className="cfg-card-title">Connection</span>
              <span className="bot-new-card-hint">
                {isDiscord ? 'credentials from Discord Developer Portal' : 'credentials from Slack app config'}
              </span>
            </div>
            <div className="cfg-card-body">
              <div className="field">
                <div className="field-lbl">{t('bots.form.label.label')}</div>
                <input
                  className="input"
                  value={form.label}
                  onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
                />
              </div>
              {isDiscord ? (
                <>
                  <TokenField
                    label="Bot Token"
                    value={de.token ?? ''}
                    onChange={v => patchExtra({ token: v })}
                  />
                  <div className="field">
                    <div className="field-lbl">Application ID</div>
                    <CopyableInput
                      value={de.application_id ?? ''}
                      onChange={v => patchExtra({ application_id: v })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <TokenField
                    label="Bot Token"
                    value={se.bot_token ?? ''}
                    onChange={v => patchExtra({ bot_token: v })}
                    placeholder="xoxb-…"
                  />
                  <TokenField
                    label="App-level Token"
                    value={se.app_token ?? ''}
                    onChange={v => patchExtra({ app_token: v })}
                    placeholder="xapp-…"
                  />
                  <div className="field">
                    <div className="field-lbl">
                      <span>Command Prefix</span>
                      <span className="field-hint">how users invoke this bot</span>
                    </div>
                    <input
                      className="input bot-mono-input"
                      value={se.command_prefix ?? '/gian'}
                      onChange={e => patchExtra({ command_prefix: e.target.value })}
                    />
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="cfg-card">
            <div className="cfg-card-head">
              <span className="cfg-card-title">Routing</span>
              <span className="bot-new-card-hint">where new sessions land · who can talk</span>
            </div>
            <div className="cfg-card-body">
              <div className="field">
                <div className="field-lbl">
                  <span>{t('bots.form.workspace.label')}</span>
                  <span className="field-hint">sessions in this workspace are reachable via the bot</span>
                </div>
                <select
                  className="select"
                  value={form.workspace_id}
                  onChange={e => setForm(p => ({ ...p, workspace_id: e.target.value }))}
                >
                  <option value="">{t('bots.workspace.none')}</option>
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <div className="field-lbl">
                  <span>{t('bots.perm.allowedusers.label')}</span>
                  <span className="field-hint">comma-separated</span>
                </div>
                <input
                  className="input bot-mono-input"
                  value={form.allowed_user_id}
                  placeholder="123456789, 987654321"
                  onChange={e => setForm(p => ({ ...p, allowed_user_id: e.target.value }))}
                />
                <p className="field-hint">{t('bots.perm.allowedusers.hint')}</p>
              </div>
            </div>
          </section>

        </div>

        {/* Mode behavior — clickable Read-only / Full-control cards. */}
        <section className="mode-behavior">
          <div className="mode-behavior-head">
            <span className="mode-behavior-title">Mode behavior</span>
          </div>
          <div className="mode-behavior-cards">
            <button
              type="button"
              className={`mode-card${form.mode === 'read-only' ? ' active' : ''}`}
              onClick={() => setForm(p => ({ ...p, mode: 'read-only' }))}
            >
              <div className="mode-card-head">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mode-card-icon">
                  <path d="M2 8s2-4.5 6-4.5S14 8 14 8s-2 4.5-6 4.5S2 8 2 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span className="mode-card-title">Read-only</span>
                {form.mode === 'read-only' && <span className="mode-card-active">· active</span>}
              </div>
              <p className="mode-card-desc">{t('bots.perm.mode.readonly.desc')}</p>
            </button>
            <button
              type="button"
              className={`mode-card${form.mode === 'full-control' ? ' active' : ''}`}
              onClick={() => setForm(p => ({ ...p, mode: 'full-control' }))}
            >
              <div className="mode-card-head">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mode-card-icon">
                  <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="mode-card-title">Full control</span>
                {form.mode === 'full-control' && <span className="mode-card-active">· active</span>}
              </div>
              <p className="mode-card-desc">{t('bots.perm.mode.fullcontrol.desc')}</p>
            </button>
          </div>
        </section>

        {/* Activity log — for now just a snapshot of connection state. A
            historical log table is a future feature; the design's per-event
            timeline is aspirational. */}
        <section className="cfg-card activity-log">
          <div className="cfg-card-head">
            <span className="cfg-card-title">Activity</span>
            <span className="bot-new-card-hint">connection state · last events</span>
          </div>
          <div className="cfg-card-body activity-log-body">
            <div className="activity-log-row">
              <span className="al-key">Status</span>
              <span className={`bot-detail-status bot-detail-status-${status}`}>
                <span className="bot-detail-status-dot" />
                {status}
              </span>
            </div>
            <div className="activity-log-row">
              <span className="al-key">Last connected</span>
              <span className="al-val">
                {bot.last_connected_at
                  ? <span title={new Date(bot.last_connected_at).toLocaleString()}>{relTime(bot.last_connected_at)}</span>
                  : <span className="al-dim">never</span>
                }
              </span>
            </div>
            {bot.last_error && (
              <div className="activity-log-error">
                <span className="al-error-tag">last error</span>
                <span className="al-error-text">{bot.last_error}</span>
              </div>
            )}
          </div>
        </section>

        {/* Danger zone — irreversible removal only. Disable lives in header. */}
        <section className="danger-zone">
          <div className="danger-zone-info">
            <span className="danger-zone-title">Danger zone</span>
            <span className="danger-zone-desc">
              Removes the bot row, credentials, and all activity history. To stop forwarding
              without losing config, use the toggle in the header instead.
            </span>
          </div>
          <div className="danger-zone-actions">
            {deleteError && <span className="bot-error">{deleteError}</span>}
            {confirmDelete && !deleting && (
              <span className="bot-delete-confirm-text">Are you sure?</span>
            )}
            {confirmDelete && (
              <button
                className="btn sm ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                {t('bots.delete.cancel')}
              </button>
            )}
            <button
              className="btn sm danger-ghost"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 4h10M6 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M5 4l.6 9.1a1 1 0 001 .9h2.8a1 1 0 001-.9L11 4M7 7v5M9 7v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {deleting ? t('bots.delete.deleting') : confirmDelete ? t('bots.delete.confirm') : t('bots.delete.button')}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

export function BotsView({
  bots,
  sessions,
  onChange,
  workspaces,
}: {
  bots: Bot[];
  sessions: Session[];
  onChange: () => void;
  workspaces?: { id: string; name: string }[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(bots[0]?.id ?? null);
  const [showNewForm, setShowNewForm] = useState(false);
  const rail = useResizableWidth('bots.rail.w', 280, 200, 480, 'left');

  const selected = bots.find(b => b.id === selectedId) ?? null;
  const ws = workspaces ?? [];

  function handleCreated(bot: Bot) {
    setShowNewForm(false);
    onChange();
    setSelectedId(bot.id);
  }

  function handleDeleted() {
    const next = bots.find(b => b.id !== selectedId);
    setSelectedId(next?.id ?? null);
    onChange();
  }

  function handleChanged(updated: Bot) {
    onChange();
    // Keep local optimistic label in the list by re-selecting same id.
    setSelectedId(updated.id);
  }

  return (
    <div
      className="view"
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      <BotListPane
        bots={bots}
        selectedId={selectedId}
        workspaces={ws}
        onSelect={id => { setSelectedId(id); setShowNewForm(false); }}
        onNewClick={() => setShowNewForm(true)}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize bots list" />
      {showNewForm ? (
        <NewBotForm
          workspaces={ws}
          onCancel={() => setShowNewForm(false)}
          onCreated={handleCreated}
        />
      ) : (
        <BotDetail
          bot={selected}
          workspaces={ws}
          sessions={sessions}
          onChange={handleChanged}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
