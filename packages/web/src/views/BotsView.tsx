import { useEffect, useMemo, useState } from 'react';
import type { Bot, BotExtra, BotMode, DiscordBotExtra, IMPlatform, Session, SlackBotExtra } from '@gian/shared';
import { createBot, deleteBot, toggleBot, updateBot } from '../api.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Icon } from './SpacesView.js';

// ── V2 icon paths used in BotsView (copied verbatim from
//    design/gian-design-v2/js/data.jsx). ──
const I = {
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  check: 'M5 12l5 5L20 7',
  copy: 'M9 9h10v10H9z M5 15V5h10',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
};

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
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          <div className="bot-detail-head">
            <span className="pmark" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>+</span>
            <div className="info">
              <div className="name">New bot</div>
              <div className="sub" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
                Wire an IM channel into a Gian workspace
              </div>
            </div>
            <div className="actions">
              <button className="btn ghost" onClick={onCancel} disabled={saving}>
                {t('bots.form.cancel')}
              </button>
              <button className="btn primary" onClick={() => void submit()} disabled={saving}>
                {saving ? t('bots.form.creating') : t('bots.form.create')}
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: 8 }}>
              Platform
            </div>
            <div className="segm">
              {(['discord', 'slack'] as IMPlatform[]).map(p => (
                <button
                  key={p}
                  type="button"
                  className={`segm-item${form.platform === p ? ' active' : ''}`}
                  onClick={() => setPlatform(p)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: p === 'discord' ? 'var(--discord)' : 'var(--slack)' }} />
                  {p === 'discord' ? 'Discord' : 'Slack'}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>01 · Identity</h3></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>{t('bots.form.label.label')}</dt>
                <dd>
                  <input
                    className="input"
                    style={{ width: '60%' }}
                    placeholder={`my-${form.platform}-bot`}
                    value={form.label}
                    onChange={e => patchForm({ label: e.target.value })}
                    autoFocus
                  />
                </dd>
                <dt>{t('bots.form.workspace.label')}</dt>
                <dd>
                  <select
                    className="select"
                    style={{ width: '60%' }}
                    value={form.workspace_id}
                    onChange={e => patchForm({ workspace_id: e.target.value })}
                  >
                    <option value="">{t('bots.workspace.none')}</option>
                    {workspaces.map(w => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>02 · Connection</h3>
              <span className="aside">
                {isDiscord ? 'credentials from Discord Developer Portal' : 'credentials from Slack App Manifest'}
              </span>
            </div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Bot token</dt>
                <dd>
                  {isDiscord ? (
                    <TokenField
                      label=""
                      value={de.token ?? ''}
                      onChange={v => patchExtra({ token: v })}
                      placeholder="MTQyMDE2MjM2NDc4OTY..."
                    />
                  ) : (
                    <TokenField
                      label=""
                      value={se.bot_token ?? ''}
                      onChange={v => patchExtra({ bot_token: v })}
                      placeholder="xoxb-…"
                    />
                  )}
                </dd>
                {isDiscord ? (
                  <>
                    <dt>Application ID</dt>
                    <dd>
                      <CopyableInput
                        value={de.application_id ?? ''}
                        placeholder="1148927316082212864"
                        onChange={v => patchExtra({ application_id: v })}
                      />
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>App-level token</dt>
                    <dd>
                      <TokenField
                        label=""
                        value={se.app_token ?? ''}
                        onChange={v => patchExtra({ app_token: v })}
                        placeholder="xapp-1-…"
                      />
                    </dd>
                    <dt>Command Prefix</dt>
                    <dd>
                      <input
                        className="input bot-mono-input"
                        style={{ width: '60%' }}
                        value={se.command_prefix ?? '/gian'}
                        placeholder="/gian"
                        onChange={e => patchExtra({ command_prefix: e.target.value })}
                      />
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>03 · Permissions</h3></div>
            <div className="card-body">
              <div className="mode-cards">
                <button
                  type="button"
                  className={`mode-card${form.mode === 'read-only' ? ' active' : ''}`}
                  onClick={() => patchForm({ mode: 'read-only' })}
                >
                  <div className="head">
                    <Icon d={I.eye} size={15} />
                    <span className="title">{t('bots.mode.readonly')}</span>
                    {form.mode === 'read-only' && <span className="pill-active">Active</span>}
                  </div>
                  <div className="desc">{t('bots.perm.mode.readonly.desc')}</div>
                </button>
                <button
                  type="button"
                  className={`mode-card${form.mode === 'full-control' ? ' active' : ''}`}
                  onClick={() => patchForm({ mode: 'full-control' })}
                >
                  <div className="head">
                    <Icon d={I.check} size={15} />
                    <span className="title">{t('bots.mode.fullcontrol')}</span>
                    {form.mode === 'full-control' && <span className="pill-active">Active</span>}
                  </div>
                  <div className="desc">
                    Allow prompts to originate from {form.platform} chat. {t('bots.perm.mode.fullcontrol.desc')}
                  </div>
                </button>
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 6 }}>
                  {t('bots.form.allowedusers.label')}
                </div>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder={`comma-separated ${form.platform} user IDs (leave empty to allow all)`}
                  value={form.allowed_user_id}
                  onChange={e => patchForm({ allowed_user_id: e.target.value })}
                />
                <p className="field-hint" style={{ marginTop: 6 }}>{t('bots.perm.allowedusers.hint')}</p>
              </div>
            </div>
          </div>

          {error && <p className="bot-error bot-new-error">{error}</p>}
        </div>
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
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          {/* ===== Header ===== */}
          <div className="bot-detail-head">
            <span className={`pmark ${bot.platform}`}>{initial}</span>
            <div className="info">
              <div className="name">{bot.label}</div>
              <div className="sub">
                <span className={`pchip ${bot.platform}`}>{bot.platform}</span>
                <span>workspace · {workspaceName ?? 'unbound'}</span>
                <span>created {formatCreated(bot.created_at)}</span>
              </div>
            </div>
            <div className="actions">
              <button
                type="button"
                className={`toggle ${bot.enabled ? 'on' : ''}`}
                disabled={togglingEnabled}
                onClick={() => void toggleEnabled()}
                title={bot.enabled ? t('bots.toggle.disable') : t('bots.toggle.enable')}
              >
                {bot.enabled ? 'Enabled' : 'Disabled'}
                <span className="track"><span className="knob" /></span>
              </button>
              <button
                className="btn primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
                title={dirty ? 'Save changes' : 'No changes'}
              >
                {saving ? t('bots.config.saving') : t('bots.config.save')}
              </button>
            </div>
          </div>

          {saveError && <p className="bot-error bot-new-error">{saveError}</p>}

          {/* ===== Connection + Routing — two-column ===== */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="card">
              <div className="card-head">
                <h3>Connection</h3>
                <span className="aside">
                  credentials from {bot.platform[0]!.toUpperCase() + bot.platform.slice(1)} Developer Portal
                </span>
              </div>
              <div className="card-body">
                <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                  <dt>Label</dt>
                  <dd style={{ fontFamily: 'var(--font-sans)' }}>
                    <input
                      className="input"
                      value={form.label}
                      onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
                      style={{ width: '100%' }}
                    />
                  </dd>

                  <dt>Bot token</dt>
                  <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {isDiscord ? (
                      <TokenField
                        label=""
                        value={de.token ?? ''}
                        onChange={v => patchExtra({ token: v })}
                      />
                    ) : (
                      <TokenField
                        label=""
                        value={se.bot_token ?? ''}
                        onChange={v => patchExtra({ bot_token: v })}
                        placeholder="xoxb-…"
                      />
                    )}
                  </dd>

                  {isDiscord ? (
                    <>
                      <dt>Application ID</dt>
                      <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CopyableInput
                          value={de.application_id ?? ''}
                          onChange={v => patchExtra({ application_id: v })}
                        />
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>App-level token</dt>
                      <dd>
                        <TokenField
                          label=""
                          value={se.app_token ?? ''}
                          onChange={v => patchExtra({ app_token: v })}
                          placeholder="xapp-…"
                        />
                      </dd>
                      <dt>Command Prefix</dt>
                      <dd>
                        <input
                          className="input bot-mono-input"
                          value={se.command_prefix ?? '/gian'}
                          onChange={e => patchExtra({ command_prefix: e.target.value })}
                          style={{ width: '60%' }}
                        />
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Routing</h3>
                <span className="aside">where new sessions land · who can talk</span>
              </div>
              <div className="card-body">
                <dl className="kv-grid" style={{ gridTemplateColumns: '140px 1fr' }}>
                  <dt>Workspace</dt>
                  <dd>
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
                  </dd>
                  <dt>{t('bots.perm.allowedusers.label')}</dt>
                  <dd>
                    <input
                      className="input bot-mono-input"
                      value={form.allowed_user_id}
                      placeholder="123456789, 987654321"
                      onChange={e => setForm(p => ({ ...p, allowed_user_id: e.target.value }))}
                      style={{ width: '100%' }}
                    />
                    <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 11, fontFamily: 'var(--font-sans)' }}>
                      {t('bots.perm.allowedusers.hint')}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          {/* ===== Mode behavior ===== */}
          <div style={{ marginTop: 14 }}>
            <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: 8 }}>
              Mode behavior
            </div>
            <div className="mode-cards">
              <button
                type="button"
                className={`mode-card${form.mode === 'read-only' ? ' active' : ''}`}
                onClick={() => setForm(p => ({ ...p, mode: 'read-only' }))}
              >
                <div className="head">
                  <Icon d={I.eye} size={15} />
                  <span className="title">{t('bots.mode.readonly')}</span>
                  {form.mode === 'read-only' && <span className="pill-active">Active</span>}
                </div>
                <div className="desc">{t('bots.perm.mode.readonly.desc')}</div>
              </button>
              <button
                type="button"
                className={`mode-card${form.mode === 'full-control' ? ' active' : ''}`}
                onClick={() => setForm(p => ({ ...p, mode: 'full-control' }))}
              >
                <div className="head">
                  <Icon d={I.check} size={15} />
                  <span className="title">{t('bots.mode.fullcontrol')}</span>
                  {form.mode === 'full-control' && <span className="pill-active">Active</span>}
                </div>
                <div className="desc">
                  Bot can send prompts and receive full event stream. Anyone on the allowlist can drive sessions from {bot.platform}.
                </div>
              </button>
            </div>
          </div>

          {/* ===== Activity ===== */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Activity</h3>
              <span className="aside">connection state · last events</span>
            </div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '160px 1fr' }}>
                <dt>Status</dt>
                <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`pill ${bot.enabled && status === 'connected' ? 'run' : 'idle'}`}>{status}</span>
                  {bot.last_error
                    ? <span style={{ color: 'var(--danger)', fontFamily: 'var(--font-sans)' }} title={bot.last_error}>{bot.last_error}</span>
                    : <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
                        {status === 'connected' ? 'gateway open' : status === 'disabled' ? 'forwarding paused' : '—'}
                      </span>}
                </dd>
                <dt>Last connected</dt>
                <dd style={{ fontFamily: 'var(--font-sans)' }}>
                  {bot.last_connected_at
                    ? <span title={new Date(bot.last_connected_at).toLocaleString()}>{relTime(bot.last_connected_at)}</span>
                    : <span style={{ color: 'var(--text-3)' }}>never</span>}
                </dd>
                {sessionsLinked > 0 && (
                  <>
                    <dt>Sessions linked</dt>
                    <dd style={{ fontFamily: 'var(--font-sans)' }}>{sessionsLinked} in {workspaceName ?? 'workspace'}</dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          {/* ===== Danger zone ===== */}
          <div className="danger-zone">
            <div style={{ flex: 1 }}>
              <h4>Danger zone</h4>
              <p>
                Removes the bot row, credentials, and all activity history. To stop forwarding
                without losing config, use the toggle in the header instead.
              </p>
            </div>
            <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                className="btn danger-ghost sm"
                disabled={deleting}
                onClick={() => void handleDelete()}
              >
                <Icon d={I.trash} size={12} />
                {deleting ? t('bots.delete.deleting') : confirmDelete ? t('bots.delete.confirm') : t('bots.delete.button')}
              </button>
            </div>
          </div>
        </div>
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
