import { useEffect, useState } from 'react';
import type { CcModelCapabilities, CodexModelCapabilities, ExternalEditor, SystemConfig } from '@gian/shared';
import { THEME_DEFAULT_ACCENT } from '@gian/shared';
import { loadProxyModels, saveSettings } from '../api.js';
import {
  browserNotificationPermission,
  loadNotificationPrefs,
  requestDesktopNotificationPermission,
  saveNotificationPrefs,
  type BrowserNotificationPermission,
  type NotificationPrefs,
} from '../notifications.js';

function newEditorId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `ed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function editorsEqual(a: ExternalEditor[], b: ExternalEditor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.command !== y.command) return false;
    if (x.args.length !== y.args.length) return false;
    for (let j = 0; j < x.args.length; j++) {
      if (x.args[j] !== y.args[j]) return false;
    }
  }
  return true;
}

interface Props {
  config: SystemConfig | null;
  onChange: (cfg: SystemConfig) => void;
}

/** V2 Settings as a Workbench tab body. Six sections per V2 design:
 *  Appearance / Executors / Notifications / Shortcuts / System / About.
 *  Account/Auth/Public access/Language are intentionally hidden (§3.11). */
export function SettingsBody({ config, onChange }: Props) {
  if (!config) return <div style={{ padding: 20, color: 'var(--text-3)' }}>Loading…</div>;
  return <SettingsBodyInner config={config} onChange={onChange} />;
}

function SettingsBodyInner({
  config, onChange,
}: {
  config: SystemConfig;
  onChange: (cfg: SystemConfig) => void;
}) {
  const [editors, setEditors] = useState<ExternalEditor[]>(config.external_editors);

  // Sync local editor state when config is replaced from outside (e.g. initial load).
  useEffect(() => {
    setEditors(config.external_editors);
  }, [config.external_editors]);

  // Debounced auto-save: schedule a patch 500ms after the user stops typing.
  // Skip when local matches prop (initial mount, post-sync).
  useEffect(() => {
    if (editorsEqual(editors, config.external_editors)) return;
    const handle = setTimeout(() => {
      void saveSettings({ external_editors: editors }).then(cfg => { if (cfg) onChange(cfg); });
    }, 500);
    return () => clearTimeout(handle);
  }, [editors, config.external_editors, onChange]);

  function patch(partial: Partial<SystemConfig>) {
    void saveSettings(partial).then(cfg => { if (cfg) onChange(cfg); });
  }

  function patchEditors(next: ExternalEditor[]) {
    setEditors(next);
  }

  return (
    <div className="settings-tab-body" data-testid="settings-body">
      <header className="settings-hero">
        <h2>Settings</h2>
        <span className="settings-hero-sub">Local instance · single user</span>
      </header>

      <div className="settings-eyebrow">Appearance</div>
      <div className="settings-section">
        <dl className="kv-grid">
          <dt>Theme</dt>
          <dd>
            <div className="theme-row">
              {([
                ['light', 'Light', ['oklch(0.955 0.004 280)', 'oklch(0.935 0.005 280)', 'oklch(0.22 0.02 280)']],
                ['warm', 'Warm', ['oklch(0.955 0.020 80)', 'oklch(0.925 0.022 78)', 'oklch(0.30 0.04 55)']],
                ['dark', 'Dark', ['oklch(0.165 0.012 250)', 'oklch(0.240 0.016 250)', 'oklch(0.93 0.01 250)']],
              ] as const).map(([key, name, swatches]) => (
                <button key={key} className={`theme-chip ${config.theme === key ? 'active' : ''}`}
                        onClick={() => patch({ theme: key, accent: THEME_DEFAULT_ACCENT[key] })}>
                  <div className="swatches">{swatches.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                  <div className="name">{name}</div>
                </button>
              ))}
            </div>
          </dd>
          <dt>Accent</dt>
          <dd>
            <div className="accent-row">
              {([
                ['rose',   'Rose',   'oklch(0.55 0.15   5)'],
                ['ember',  'Ember',  'oklch(0.55 0.14  35)'],
                ['citron', 'Citron', 'oklch(0.55 0.13  95)'],
                ['moss',   'Moss',   'oklch(0.55 0.11 150)'],
                ['teal',   'Teal',   'oklch(0.55 0.11 195)'],
                ['azure',  'Azure',  'oklch(0.55 0.13 230)'],
                ['ink',    'Ink',    'oklch(0.55 0.13 270)'],
                ['plum',   'Plum',   'oklch(0.55 0.14 320)'],
              ] as const).map(([k, name, c]) => (
                <button key={k} className={`accent-swatch ${config.accent === k ? 'active' : ''}`}
                        style={{ background: c }}
                        title={name}
                        onClick={() => patch({ accent: k })}>
                  <span className="accent-name">{name}</span>
                </button>
              ))}
            </div>
          </dd>
          <dt>Density</dt>
          <dd>
            <div className="segm">
              {(['compact', 'cozy', 'roomy'] as const).map(d => (
                <button key={d} className={`segm-item ${config.density === d ? 'active' : ''}`}
                        onClick={() => patch({ density: d })}>
                  {d[0]!.toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
          </dd>
          <dt>Font · Interface</dt>
          <dd>
            <div className="segm">
              {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                <button key={s} className={`segm-item ${config.font_scale_chrome === s ? 'active' : ''}`}
                        onClick={() => patch({ font_scale_chrome: s })}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </dd>
          <dt>Font · Transcript</dt>
          <dd>
            <div className="segm">
              {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                <button key={s} className={`segm-item ${config.font_scale_chat === s ? 'active' : ''}`}
                        onClick={() => patch({ font_scale_chat: s })}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </dd>
          <dt>Font · Code</dt>
          <dd>
            <div className="segm">
              {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                <button key={s} className={`segm-item ${config.font_scale_code === s ? 'active' : ''}`}
                        onClick={() => patch({ font_scale_code: s })}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </dd>
          <dt>Font</dt>
          <dd className="mono" style={{ color: 'var(--text-3)' }}>Instrument Sans · JetBrains Mono</dd>
        </dl>
      </div>

      <div className="settings-eyebrow">Executors</div>
      <div className="settings-section">
        <ExecutorRow
          name="Claude Code"
          executor="claude"
          model={config.default_claude_model}
          effort={config.default_claude_effort}
          onSetModel={v => patch({ default_claude_model: v })}
          onSetEffort={v => patch({ default_claude_effort: v })}
        />
        <ExecutorRow
          name="Codex"
          executor="codex"
          model={config.default_codex_model}
          effort={config.default_codex_effort}
          onSetModel={v => patch({ default_codex_model: v })}
          onSetEffort={v => patch({ default_codex_effort: v })}
        />
      </div>

      <div className="settings-eyebrow">Notifications</div>
      <div className="settings-section">
        <NotificationsBlock />
      </div>

      <div className="settings-eyebrow">Shortcuts</div>
      <div className="settings-section">
        <dl className="kv-grid shortcuts">
          <dt>Command palette</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd>
          <dt>New session</dt><dd><kbd>⌘</kbd><kbd>N</kbd></dd>
          <dt>Toggle workbench</dt><dd><kbd>⌘</kbd><kbd>\</kbd></dd>
          <dt>Rename session</dt><dd><kbd>F2</kbd></dd>
          <dt>Approve / decline</dt><dd><kbd>⏎</kbd>&nbsp;<kbd>⌫</kbd></dd>
        </dl>
      </div>

      <div className="settings-eyebrow">System</div>
      <div className="settings-section">
        <dl className="kv-grid">
          <dt>Runner</dt>
          <dd className="mono">{config.host}:{config.port}</dd>
          <dt>Workspace root</dt>
          <dd className="mono">{config.workspace_root}</dd>
        </dl>
      </div>

      <div className="settings-eyebrow">About</div>
      <div className="settings-section">
        <dl className="kv-grid">
          <dt>Version</dt><dd className="mono">Gian (dev)</dd>
          <dt>Channel</dt><dd>local</dd>
        </dl>
      </div>

      <div className="settings-eyebrow">External editors</div>
      <div className="settings-section">
        <p className="settings-section-help">
          Programs in the Files view's Open menu. <code>{'{path}'}</code> in Args is
          replaced with the file path; otherwise the path is appended. Args are split
          on whitespace — arguments containing spaces aren't supported.
        </p>
        {editors.length === 0 && (
          <p className="settings-empty">No editors configured. Add one to use it from the Files view.</p>
        )}
        {editors.map((ed, i) => (
          <div key={ed.id} className="external-editor-row">
            <label>
              <span className="ee-label">Name</span>
              <input
                type="text"
                value={ed.name}
                maxLength={64}
                onChange={e => {
                  const next = [...editors];
                  next[i] = { ...ed, name: e.target.value };
                  patchEditors(next);
                }}
              />
            </label>
            <label>
              <span className="ee-label">Command</span>
              <input
                type="text"
                value={ed.command}
                onChange={e => {
                  const next = [...editors];
                  next[i] = { ...ed, command: e.target.value };
                  patchEditors(next);
                }}
              />
            </label>
            <label>
              <span className="ee-label">Args</span>
              <input
                type="text"
                aria-label="Args"
                defaultValue={ed.args.join(' ')}
                onBlur={e => {
                  const tokens = e.target.value.trim().length === 0
                    ? []
                    : e.target.value.trim().split(/\s+/);
                  const next = [...editors];
                  next[i] = { ...ed, args: tokens };
                  patchEditors(next);
                }}
              />
            </label>
            <button
              type="button"
              aria-label="Remove editor"
              className="ee-remove"
              onClick={() => {
                const next = editors.filter(x => x.id !== ed.id);
                patchEditors(next);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const next = [
              ...editors,
              { id: newEditorId(), name: '', command: '', args: [] },
            ];
            patchEditors(next);
          }}
        >
          + Add editor
        </button>
      </div>
    </div>
  );
}

/** Renders one executor block (Claude or Codex). Model list comes from
 *  `loadProxyModels(executor)`; effort options derive from the selected
 *  model's capability struct — Cc exposes `supportedEfforts` (low/med/high/max),
 *  Codex exposes `supportedThinking` (minimal/low/med/high/xhigh). Nothing
 *  about the list is hardcoded — when the proxy adds a model or adjusts its
 *  supported levels, this UI follows. */
function ExecutorRow({
  name, executor, model, effort, onSetModel, onSetEffort,
}: {
  name: string;
  executor: 'claude' | 'codex';
  model: string;
  effort: string;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
}) {
  const [models, setModels] = useState<Array<CcModelCapabilities | CodexModelCapabilities>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    loadProxyModels(executor)
      .then(list => {
        if (!alive) return;
        setModels(list);
        setLoading(false);
        if (list.length === 0) setError(true);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
        setError(true);
      });
    return () => { alive = false; };
  }, [executor]);

  const visible = models.filter(m => !m.hidden);
  const selected = models.find(m => m.model === model.trim());
  const efforts = selected
    ? (executor === 'claude'
        ? (selected as CcModelCapabilities).supportedEfforts
        : (selected as CodexModelCapabilities).supportedThinking)
    : [];

  const status =
    loading ? { cls: 'loading', label: 'loading…' }
    : error ? { cls: 'err', label: 'proxy unavailable' }
    : { cls: 'ok', label: 'ready' };

  return (
    <div className="exec-row">
      <div className="exec-head">
        <span className={`exec-dot ${executor}`} />
        <span className="exec-name">{name}</span>
        <span className={`exec-status ${status.cls}`}>{status.label}</span>
      </div>
      <dl className="kv-grid">
        <dt>Default model</dt>
        <dd>
          <select
            className="select mono"
            style={{ width: '100%' }}
            value={model}
            disabled={loading || visible.length === 0}
            onChange={e => {
              const next = e.target.value;
              onSetModel(next);
              // Reset effort when the new model doesn't support the current value.
              const m = models.find(x => x.model === next);
              const supported = m
                ? (executor === 'claude'
                    ? (m as CcModelCapabilities).supportedEfforts
                    : (m as CodexModelCapabilities).supportedThinking)
                : [];
              if (effort && !supported.includes(effort as never)) {
                onSetEffort('');
              }
            }}
          >
            <option value="">(proxy default)</option>
            {visible.map(m => (
              <option key={m.id} value={m.model}>{m.displayName || m.model}</option>
            ))}
          </select>
        </dd>
        {efforts.length > 0 && (
          <>
            <dt>Effort</dt>
            <dd>
              <select
                className="select mono"
                style={{ width: '100%' }}
                value={effort}
                onChange={e => onSetEffort(e.target.value)}
              >
                <option value="">(model default)</option>
                {efforts.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function NotificationsBlock() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => loadNotificationPrefs());
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() => browserNotificationPermission());
  const desktopEnabled = prefs.desktop && permission === 'granted';
  const unavailable = permission === 'unsupported' || permission === 'denied';

  function patch(partial: Partial<NotificationPrefs>) {
    setPrefs(prev => saveNotificationPrefs({ ...prev, ...partial }));
  }

  async function setDesktop(enabled: boolean) {
    if (!enabled) {
      patch({ desktop: false });
      return;
    }
    const nextPermission = await requestDesktopNotificationPermission();
    setPermission(nextPermission);
    patch({ desktop: nextPermission === 'granted' });
  }

  const statusText =
    permission === 'granted'
      ? 'Session done · approval needed · error'
      : permission === 'denied'
        ? 'Blocked in browser'
        : permission === 'unsupported'
          ? 'Unsupported in this browser'
          : 'Click to allow desktop alerts';

  return (
    <dl className="kv-grid">
      <dt>Desktop</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={desktopEnabled}
            disabled={unavailable}
            onChange={e => { void setDesktop(e.target.checked); }}
          />
          <span>{statusText}</span>
        </label>
      </dd>
      <dt>Events</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.sessionDone}
            disabled={!desktopEnabled}
            onChange={e => patch({ sessionDone: e.target.checked })}
          />
          <span>Session done</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.approvalNeeded}
            disabled={!desktopEnabled}
            onChange={e => patch({ approvalNeeded: e.target.checked })}
          />
          <span>Approval needed</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.errors}
            disabled={!desktopEnabled}
            onChange={e => patch({ errors: e.target.checked })}
          />
          <span>Error</span>
        </label>
      </dd>
      <dt>Sound</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.sound}
            disabled={!desktopEnabled}
            onChange={e => patch({ sound: e.target.checked })}
          />
          <span>Soft chime on approval</span>
        </label>
      </dd>
      <dt>Dock badge</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.badge}
            onChange={e => patch({ badge: e.target.checked })}
          />
          <span>Show pending approval count</span>
        </label>
      </dd>
    </dl>
  );
}
