import { useEffect, useState } from 'react';
import type { CcModelCapabilities, CodexModelCapabilities, SystemConfig } from '@gian/shared';
import { loadProxyModels, saveSettings } from '../api.js';

interface Props {
  config: SystemConfig | null;
  onChange: (cfg: SystemConfig) => void;
}

/** V2 Settings as a Workbench tab body. Six sections per V2 design:
 *  Appearance / Executors / Notifications / Shortcuts / System / About.
 *  Account/Auth/Public access/Language are intentionally hidden (§3.11). */
export function SettingsBody({ config, onChange }: Props) {
  if (!config) return <div style={{ padding: 20, color: 'var(--text-3)' }}>Loading…</div>;

  function patch(partial: Partial<SystemConfig>) {
    void saveSettings(partial).then(cfg => { if (cfg) onChange(cfg); });
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
                        onClick={() => patch({ theme: key })}>
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
                ['plum', 'Plum', 'oklch(0.55 0.13 310)'],
                ['moss', 'Moss', 'oklch(0.55 0.10 150)'],
                ['ink', 'Ink', 'oklch(0.55 0.11 255)'],
                ['ember', 'Ember', 'oklch(0.55 0.13 30)'],
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

/** Phase 3 placeholder — V2 layout, no persistence yet. */
function NotificationsBlock() {
  const [desktop, setDesktop] = useState(true);
  const [sound, setSound] = useState(false);
  const [badge, setBadge] = useState(true);
  return (
    <dl className="kv-grid">
      <dt>Desktop</dt>
      <dd>
        <label className="switch">
          <input type="checkbox" checked={desktop} onChange={e => setDesktop(e.target.checked)} />
          <span>Approval needed · session done · error</span>
        </label>
      </dd>
      <dt>Sound</dt>
      <dd>
        <label className="switch">
          <input type="checkbox" checked={sound} onChange={e => setSound(e.target.checked)} />
          <span>Soft chime on approval</span>
        </label>
      </dd>
      <dt>Dock badge</dt>
      <dd>
        <label className="switch">
          <input type="checkbox" checked={badge} onChange={e => setBadge(e.target.checked)} />
          <span>Show pending approval count</span>
        </label>
      </dd>
    </dl>
  );
}
