import type { LayoutPreferences, SystemConfig, ToolPreferences } from '@gian/shared';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';
import { useT } from '../i18n/index.js';
import { SettingsStepper } from './SettingsStepper.js';

type Patch = (partial: Partial<SystemConfig>) => void;

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-page preference-page">
      <div className="settings-page-heading"><h2>{title}</h2></div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, label }: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
}) {
  return (
    <label className="switch settings-switch">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function LayoutSettingsPage({ config, onPatch }: { config: SystemConfig; onPatch: Patch }) {
  const t = useT();
  const layout = config.layout ?? DEFAULT_LAYOUT_PREFERENCES;
  const update = (change: Partial<LayoutPreferences>) => onPatch({ layout: { ...layout, ...change } });
  const decrease = (label: string) => t('settings.stepper.decrease').replace('{label}', label);
  const increase = (label: string) => t('settings.stepper.increase').replace('{label}', label);
  const sidebarWidth = t('settings.layout.sidebarWidth');
  const panel2Ratio = t('settings.layout.panel2Ratio');
  const panel3Width = t('settings.layout.panel3Width');
  return (
    <Page title={t('settings.layout.title')}>
      <div className="s2-card">
        <dl className="kv-grid layout-settings-grid">
          <dt>{sidebarWidth}</dt>
          <dd><SettingsStepper label={sidebarWidth} value={layout.sidebar_width} min={200} max={480} step={8}
                               decreaseLabel={decrease(sidebarWidth)} increaseLabel={increase(sidebarWidth)}
                               formatValue={value => `${value}px`}
                               onChange={sidebar_width => update({ sidebar_width })} /></dd>
          <ToggleRow label={t('settings.layout.sidebarCollapsedHint')} value={layout.sidebar_start_collapsed}
                     onChange={sidebar_start_collapsed => update({ sidebar_start_collapsed })} />
          <dt>{panel2Ratio}</dt>
          <dd><SettingsStepper label={panel2Ratio} value={layout.main_panel_ratio} min={0.25} max={0.75} step={0.05}
                               decreaseLabel={decrease(panel2Ratio)} increaseLabel={increase(panel2Ratio)}
                               formatValue={value => `${Math.round(value * 100)}%`}
                               onChange={main_panel_ratio => update({ main_panel_ratio })} /></dd>
          <dt>{panel3Width}</dt>
          <dd><SettingsStepper label={panel3Width} value={layout.inspector_width} min={220} max={500} step={10}
                               decreaseLabel={decrease(panel3Width)} increaseLabel={increase(panel3Width)}
                               formatValue={value => `${value}px`}
                               onChange={inspector_width => update({ inspector_width })} /></dd>
          <ToggleRow label={t('settings.layout.panel3AutoHint')} value={layout.inspector_auto_open}
                     onChange={inspector_auto_open => update({ inspector_auto_open })} />
          <ToggleRow label={t('settings.layout.rememberHint')} value={layout.remember_sizes}
                     onChange={remember_sizes => update({ remember_sizes })} />
        </dl>
      </div>
      <button className="btn secondary settings-reset-layout"
              disabled={JSON.stringify(layout) === JSON.stringify(DEFAULT_LAYOUT_PREFERENCES)}
              onClick={() => onPatch({ layout: { ...DEFAULT_LAYOUT_PREFERENCES } })}>
        {t('settings.layout.reset')}
      </button>
    </Page>
  );
}

export type ToolSettingsPageKey = keyof ToolPreferences;

export function ToolSettingsPage({
  tool,
  config,
  onPatch,
  onClearBrowserData,
  clearingBrowserData = false,
  showTitle = true,
}: {
  tool: ToolSettingsPageKey;
  config: SystemConfig;
  onPatch: Patch;
  onClearBrowserData?(): void;
  clearingBrowserData?: boolean;
  showTitle?: boolean;
}) {
  const t = useT();
  const tools = config.tools ?? DEFAULT_TOOL_PREFERENCES;
  const update = <K extends ToolSettingsPageKey>(key: K, change: Partial<ToolPreferences[K]>) => {
    onPatch({ tools: { ...tools, [key]: { ...tools[key], ...change } } });
  };

  const content = <div className="s2-card"><dl className="kv-grid tool-settings-grid">
        {tool === 'files' && <>
          <ToggleRow label={t('settings.tool.files.compact')} value={tools.files.compact_folders} onChange={compact_folders => update('files', { compact_folders })} />
          <ToggleRow label={t('settings.tool.files.hidden')} value={tools.files.show_hidden_files} onChange={show_hidden_files => update('files', { show_hidden_files })} />
          <ToggleRow label={t('settings.tool.files.ignored')} value={tools.files.show_ignored_files} onChange={show_ignored_files => update('files', { show_ignored_files })} />
          <ToggleRow label={t('settings.tool.files.reveal')} value={tools.files.reveal_active_file} onChange={reveal_active_file => update('files', { reveal_active_file })} />
          <SelectRow label={t('settings.tool.files.openOn')} value={tools.files.open_on}
                     options={[['single-click', t('settings.tool.files.single')], ['double-click', t('settings.tool.files.double')]]}
                     onChange={open_on => update('files', { open_on: open_on as ToolPreferences['files']['open_on'] })} />
          <ToggleRow label={t('settings.tool.files.wrap')} value={tools.files.word_wrap} onChange={word_wrap => update('files', { word_wrap })} />
        </>}
        {tool === 'diffs' && <>
          <SelectRow label={t('settings.tool.diffs.layout')} value={tools.diffs.layout}
                     options={[['split', t('settings.tool.diffs.split')], ['stacked', t('settings.tool.diffs.stacked')]]}
                     onChange={layout => update('diffs', { layout: layout as ToolPreferences['diffs']['layout'] })} />
          <ToggleRow label={t('settings.tool.diffs.wrap')} value={tools.diffs.word_wrap} onChange={word_wrap => update('diffs', { word_wrap })} />
          <SelectRow label={t('settings.tool.diffs.scope')} value={tools.diffs.default_scope}
                     options={[['all', t('settings.tool.diffs.all')], ['last-turn', t('settings.tool.diffs.lastTurn')]]}
                     onChange={default_scope => update('diffs', { default_scope: default_scope as ToolPreferences['diffs']['default_scope'] })} />
        </>}
        {tool === 'history' && <>
          <ToggleRow label={t('settings.tool.history.graph')} value={tools.history.show_graph} onChange={show_graph => update('history', { show_graph })} />
          <SelectRow label={t('settings.tool.history.ref')} value={tools.history.default_ref}
                     options={[['current', t('settings.tool.history.current')], ['all', t('settings.tool.history.all')]]}
                     onChange={default_ref => update('history', { default_ref: default_ref as ToolPreferences['history']['default_ref'] })} />
          <SelectRow label={t('settings.tool.history.date')} value={tools.history.date_format}
                     options={[['relative', t('settings.tool.history.relative')], ['absolute', t('settings.tool.history.absolute')]]}
                     onChange={date_format => update('history', { date_format: date_format as ToolPreferences['history']['date_format'] })} />
          <ToggleRow label={t('settings.tool.history.preview')} value={tools.history.single_click_preview} onChange={single_click_preview => update('history', { single_click_preview })} />
        </>}
        {tool === 'side_chat' && <>
          <ToggleRow label={t('settings.tool.sidechat.open')} value={tools.side_chat.open_after_create} onChange={open_after_create => update('side_chat', { open_after_create })} />
          <ToggleRow label={t('settings.tool.sidechat.confirm')} value={tools.side_chat.confirm_before_close} onChange={confirm_before_close => update('side_chat', { confirm_before_close })} />
        </>}
        {tool === 'browser' && <>
          <dt>{t('settings.tool.browser.home')}</dt>
          <dd><input className="input" value={tools.browser.home_page}
                     placeholder="https://"
                     onChange={event => update('browser', { home_page: event.target.value })} /></dd>
          <ToggleRow label={t('settings.tool.browser.restore')} value={tools.browser.restore_last_page} onChange={restore_last_page => update('browser', { restore_last_page })} />
          <SelectRow label={t('settings.tool.browser.external')} value={tools.browser.external_links}
                     options={[['gian', t('settings.tool.browser.gian')], ['system', t('settings.tool.browser.system')]]}
                     onChange={external_links => update('browser', { external_links: external_links as ToolPreferences['browser']['external_links'] })} />
          {onClearBrowserData && <>
            <dt>{t('settings.browserData.title')}</dt>
            <dd><button className="btn secondary" disabled={clearingBrowserData} onClick={onClearBrowserData}>
              {clearingBrowserData ? t('settings.browserData.clearing') : t('settings.browserData.clear')}
            </button></dd>
          </>}
        </>}
        {tool === 'terminal' && <>
          <ToggleRow label={t('settings.tool.terminal.meta')} value={tools.terminal.option_as_meta} onChange={option_as_meta => update('terminal', { option_as_meta })} />
          <ToggleRow label={t('settings.tool.terminal.copy')} value={tools.terminal.copy_on_selection} onChange={copy_on_selection => update('terminal', { copy_on_selection })} />
          <ToggleRow label={t('settings.tool.terminal.bell')} value={tools.terminal.bell} onChange={bell => update('terminal', { bell })} />
          <ToggleRow label={t('settings.tool.terminal.integration')} value={tools.terminal.shell_integration} onChange={shell_integration => update('terminal', { shell_integration })} />
        </>}
      </dl></div>;
  return showTitle ? <Page title={t(`settings.tool.${tool}.title`)}>{content}</Page> : content;
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange(value: boolean): void }) {
  return <><dt className="settings-toggle-spacer" aria-hidden="true" /><dd className="settings-toggle-row"><Switch checked={value} onChange={onChange} label={label} /></dd></>;
}

function SelectRow({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange(value: string): void;
}) {
  return <><dt>{label}</dt><dd><select className="select" aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    {options.map(([option, text]) => <option value={option} key={option}>{text}</option>)}
  </select></dd></>;
}
