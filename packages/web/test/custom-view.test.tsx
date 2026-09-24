// Custom — read-only Customization Inventory page (Issue #50).
// Covers the page's behavior contract against a mocked Host API:
//   - four kind tabs (Skills/MCP/Hooks/Rules) with per-kind counts; a failing
//     kind never hides the others (per-kind error isolation);
//   - scope grouping (Workspace · name first, then Global) and the Rules
//     Effective chain / Other discovered rules grouping with the frozen
//     Active / Imported / Applies under … / Not active vocabulary over
//     Global / Project / Subdirectory scopes, ordered Global → Project →
//     Subdirectory regardless of wire order;
//   - search is local-only and never re-probes;
//   - Agent/Scope switches invalidate the in-flight request — a late response
//     from the old context never writes into the new one;
//   - Refresh is the only data operation (refresh=1); a failed Refresh keeps
//     the previous results AND says so in a non-blocking notice with Retry;
//   - item selection opens the read-only detail sheet (lazy detail fetch),
//     switching Tab/Agent closes it at the event boundary, and a Refresh
//     keeps the detail only while its stable ID survives;
//   - "Open in VS Code" exists only for Workspace-scope Skill/Rule entries —
//     MCP/Hook details are always Copy-only;
//   - page-level states: initial loading skeleton, no agents (Set up CTA),
//     agent not ready (no probe), kind-level provider/proxy/unavailable
//     states with their CTAs (Open Agents / Retry).

import { render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserAgentStatus, Workspace } from '@gian/shared';
import {
  loadAgents,
  loadCustomizationDetail,
  loadCustomizationInventory,
  type CustomizationInventoryResult,
  type CustomizationItem,
  type CustomizationListResult,
  type RuleEffectStatus,
} from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { CustomView } from '../src/views/CustomView.js';

vi.mock('../src/api.js', () => ({
  loadAgents: vi.fn(),
  loadCustomizationInventory: vi.fn(),
  loadCustomizationDetail: vi.fn(),
}));

const mockLoadAgents = vi.mocked(loadAgents);
const mockInventory = vi.mocked(loadCustomizationInventory);
const mockDetail = vi.mocked(loadCustomizationDetail);

const WS: Workspace = {
  id: 'ws-1',
  name: 'Gian-Dev',
  path: '/ws/Gian-Dev',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function makeAgent(overrides: Partial<UserAgentStatus> = {}): UserAgentStatus {
  return {
    id: 'agent-codex',
    name: 'Codex',
    proxy: 'codex',
    cliPath: '/bin/codex',
    defaults: { model: '', thinking: '', mode: '' },
    proxyName: 'Codex',
    ready: true,
    cli: { state: 'ready', path: '/bin/codex', version: '1.0.0', source: 'path' },
    plugin: {
      state: 'ready',
      path: '/proxies/codex',
      version: '1.5.0',
      source: 'development',
      defaults: { model: '', thinking: '', mode: '' },
    },
    runtimeProfile: null,
    officialInstallUrl: 'https://example.com/codex',
    ...overrides,
  };
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `ci1_${String(idSeq).padStart(32, '0')}`;
}

function skillItem(overrides: Partial<CustomizationItem> = {}): CustomizationItem {
  return {
    id: nextId(),
    kind: 'skill',
    name: 'review-diff',
    description: 'Reviews the staged diff',
    activation: 'enabled',
    scope: { level: 'workspace' },
    origin: { kind: 'project_file', path: '/ws/Gian-Dev/.codex/skills/review-diff' },
    discovery: { method: 'provider_api' },
    skill: {
      format: 'agent-skill',
      entryPath: '/ws/Gian-Dev/.codex/skills/review-diff/SKILL.md',
      userInvocable: true,
      modelInvocable: true,
    },
    ...overrides,
  } as CustomizationItem;
}

function mcpItem(overrides: Partial<CustomizationItem> = {}): CustomizationItem {
  return {
    id: nextId(),
    kind: 'mcp',
    name: 'github',
    description: 'Issues, PRs, and code search',
    activation: 'enabled',
    scope: { level: 'workspace' },
    origin: { kind: 'project_file', path: '/ws/Gian-Dev/.codex/config.toml' },
    discovery: { method: 'config_parse' },
    mcp: { transport: 'stdio', toolCount: 14 },
    ...overrides,
  } as CustomizationItem;
}

function ruleItem(
  status: RuleEffectStatus,
  name: string,
  scopeLevel: 'user' | 'workspace' | 'directory',
  appliesTo?: string,
): CustomizationItem {
  return {
    id: nextId(),
    kind: 'rule',
    name,
    activation: 'unknown',
    scope: { level: scopeLevel },
    origin: { kind: scopeLevel === 'user' ? 'user_file' : 'project_file', path: `/ws/Gian-Dev/${name}` },
    discovery: { method: 'filesystem_scan' },
    rule: { truncated: false, status, ...(appliesTo ? { appliesTo } : {}) },
  } as CustomizationItem;
}

function kindResult(
  kind: CustomizationItem['kind'],
  items: CustomizationItem[],
  overrides: Partial<CustomizationListResult> = {},
): CustomizationListResult {
  return {
    kind,
    status: 'ok',
    completeness: 'effective',
    observedAt: new Date().toISOString(),
    items,
    truncated: false,
    diagnostics: [],
    ...overrides,
  };
}

function unavailableResult(kind: CustomizationItem['kind'], status: 'provider_unsupported' | 'proxy_unsupported' | 'unavailable', code: string): CustomizationListResult {
  return {
    kind,
    status,
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics: [{ code, message: `${code} happened` }],
  };
}

function inventory(kinds: Partial<CustomizationInventoryResult['kinds']>): CustomizationInventoryResult {
  return {
    agentId: 'agent-codex',
    workspaceId: WS.id,
    fetchedAt: new Date().toISOString(),
    kinds,
  };
}

function detailText(kind: CustomizationItem['kind'], id: string, text: string) {
  return { kind, id, status: 'ok' as const, observedAt: new Date().toISOString(), text, truncated: false };
}

function renderView(onOpenAgents = vi.fn()) {
  const utils = render(
    <LocaleProvider locale="en">
      <CustomView
        mode="custom"
        onSetMode={() => {}}
        workspaces={[WS]}
        onOpenAgents={onOpenAgents}
      />
    </LocaleProvider>,
  );
  return { onOpenAgents, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  idSeq = 0;
});

describe('CustomView', () => {
  it('loads the inventory, renders tab counts and scope groups, and opens a read-only detail', async () => {
    const workspaceSkill = skillItem();
    const globalSkill = skillItem({
      id: nextId(),
      name: 'code-review',
      scope: { level: 'user' },
      origin: { kind: 'user_file', path: '/home/me/.codex/skills/code-review' },
    } as Partial<CustomizationItem>);
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [workspaceSkill, globalSkill]),
      mcp: kindResult('mcp', []),
      hook: unavailableResult('hook', 'provider_unsupported', 'PROVIDER_INSPECTION_FAILED'),
      rule: kindResult('rule', []),
    }));
    mockDetail.mockResolvedValue(detailText('skill', workspaceSkill.id, '# Review Diff\n\nRun before committing.'));

    renderView();

    // Rows appear grouped: Workspace first, then Global.
    const row = await screen.findByTestId(`custom-row-${workspaceSkill.id}`);
    expect(screen.getByTestId(`custom-row-${globalSkill.id}`)).toBeInTheDocument();
    expect(screen.getByText('Repo · Gian-Dev')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    // Tab counts: ok kinds show item counts, the failing kind shows '—'.
    expect(screen.getByTestId('custom-tab-skill')).toHaveTextContent('2');
    expect(screen.getByTestId('custom-tab-hook')).toHaveTextContent('—');
    // The aggregate request carries the defaulted Agent + Workspace scope.
    expect(mockInventory).toHaveBeenCalledWith('agent-codex', WS.id);

    // Selecting a row lazily opens the read-only detail sheet.
    await userEvent.click(row);
    expect(await screen.findByTestId('custom-detail-text')).toHaveTextContent('# Review Diff');
    expect(mockDetail).toHaveBeenCalledWith('agent-codex', WS.id, 'skill', workspaceSkill.id);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeInTheDocument();
  });

  it('hides disabled Agents from the selector and defaults to an enabled one', async () => {
    mockLoadAgents.mockResolvedValue([
      makeAgent({ enabled: false }),
      makeAgent({ id: 'agent-kimi', name: 'Kimi', proxy: 'kimi' }),
    ]);
    mockInventory.mockResolvedValue(inventory({ skill: kindResult('skill', []) }));

    renderView();
    // The disabled Agent is never the default: the enabled one wins and the
    // inventory request goes out under its identity.
    await waitFor(() => expect(mockInventory).toHaveBeenCalledWith('agent-kimi', WS.id));
    await userEvent.click(await screen.findByRole('button', { name: 'Agent' }));
    expect(screen.queryByRole('menuitemradio', { name: /Codex/ })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Kimi/ })).toBeInTheDocument();
  });

  it('shows a stable loading skeleton while the agents list is still loading', () => {    mockLoadAgents.mockReturnValue(new Promise(() => {})); // never settles
    renderView();
    expect(screen.getByTestId('custom-skeleton')).toBeInTheDocument();
  });

  it('invalidates the in-flight request when switching Agent — a late response never pollutes the new context', async () => {
    let resolveOld: (value: CustomizationInventoryResult) => void = () => {};
    const oldRequest = new Promise<CustomizationInventoryResult>(resolve => { resolveOld = resolve; });
    mockLoadAgents.mockResolvedValue([
      makeAgent(),
      makeAgent({ id: 'agent-kimi', name: 'Kimi', proxy: 'kimi' }),
    ]);
    mockInventory
      .mockImplementationOnce(() => oldRequest)
      .mockResolvedValue(inventory({ skill: kindResult('skill', [skillItem({ name: 'kimi-skill' })]) }));

    renderView();
    // The old Agent's request is in flight; switch to Kimi before it settles.
    await screen.findByRole('button', { name: 'Agent' });
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Kimi/ }));

    expect(await screen.findByText('kimi-skill')).toBeInTheDocument();
    // The stale response from the previous Agent arrives late — it must not
    // write into the new context.
    resolveOld(inventory({ skill: kindResult('skill', [skillItem({ name: 'codex-skill' })]) }));
    await waitFor(() => expect(screen.queryByText('codex-skill')).not.toBeInTheDocument());
    expect(screen.getByText('kimi-skill')).toBeInTheDocument();
  });

  it('filters by search text locally without re-probing the Host', async () => {
    const keep = skillItem({ name: 'review-diff' });
    const drop = skillItem({ name: 'commit-msg' });
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({ skill: kindResult('skill', [keep, drop]) }));
    mockDetail.mockResolvedValue(detailText('skill', keep.id, 'x'));

    renderView();
    await screen.findByTestId(`custom-row-${keep.id}`);
    const callsBefore = mockInventory.mock.calls.length;

    await userEvent.type(screen.getByPlaceholderText('Search customizations...'), 'commit');
    expect(screen.queryByTestId(`custom-row-${keep.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`custom-row-${drop.id}`)).toBeInTheDocument();
    expect(mockInventory.mock.calls.length).toBe(callsBefore);
  });

  it('shows a per-kind unsupported state without hiding the other tabs', async () => {
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [skillItem()]),
      hook: unavailableResult('hook', 'provider_unsupported', 'PROVIDER_INSPECTION_FAILED'),
    }));

    renderView();
    await screen.findByTestId('custom-tab-hook');
    await userEvent.click(screen.getByTestId('custom-tab-hook'));

    expect(await screen.findByText('Codex does not support listing hooks')).toBeInTheDocument();
    // Other tabs still render their inventory.
    await userEvent.click(screen.getByTestId('custom-tab-skill'));
    expect(await screen.findByText('review-diff')).toBeInTheDocument();
  });

  it('surfaces proxy upgrade required with an Open Agents action', async () => {
    const onOpenAgents = vi.fn();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: unavailableResult('skill', 'proxy_unsupported', 'PROXY_UPGRADE_REQUIRED'),
    }));

    renderView(onOpenAgents);
    expect(await screen.findByText('Proxy upgrade required')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Agents' }));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for an unavailable kind and retries through a cache-bypassing refresh', async () => {
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: unavailableResult('skill', 'unavailable', 'PROVIDER_INSPECTION_FAILED'),
    }));

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(mockInventory).toHaveBeenCalledWith('agent-codex', WS.id, { refresh: true });
    });
  });

  it('keeps a blocking error state when Retry fails before any inventory has loaded', async () => {
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory
      .mockRejectedValueOnce(new Error('initial transport failure'))
      .mockRejectedValueOnce(new Error('retry transport failure'));

    renderView();
    expect(await screen.findByText('initial transport failure')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('retry transport failure')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('custom-refresh-failed')).not.toBeInTheDocument();
    expect(mockInventory).toHaveBeenLastCalledWith('agent-codex', WS.id, { refresh: true });
  });

  it('keeps previous results on a failed refresh and says so in a non-blocking notice with Retry', async () => {
    const item = skillItem();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', [item]) }))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', [item]) }));

    renderView();
    expect(await screen.findByTestId(`custom-row-${item.id}`)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('custom-refresh'));
    const notice = await screen.findByTestId('custom-refresh-failed');
    expect(notice).toHaveTextContent('Refresh failed — showing the previous results.');
    // Previous results stay visible — the failure is not hidden.
    expect(screen.getByTestId(`custom-row-${item.id}`)).toBeInTheDocument();

    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('custom-refresh-failed')).not.toBeInTheDocument());
    expect(mockInventory).toHaveBeenLastCalledWith('agent-codex', WS.id, { refresh: true });
  });

  it('keeps the partial notice and diagnostics visible when a partial result has zero items', async () => {
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [], {
        completeness: 'partial',
        diagnostics: [{ code: 'SOURCE_UNREADABLE', message: 'skills dir unreadable' }],
      }),
    }));

    renderView();
    expect(await screen.findByTestId('custom-partial-notice')).toHaveTextContent('Partial results');
    expect(screen.getByText('No skills found')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'View diagnostics' }));
    expect(screen.getByText('SOURCE_UNREADABLE')).toBeInTheDocument();
  });

  it('renders the no-agents state with a setup CTA', async () => {
    const onOpenAgents = vi.fn();
    mockLoadAgents.mockResolvedValue([]);

    renderView(onOpenAgents);
    expect(await screen.findByText('No agents configured')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set up an agent' }));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
    expect(mockInventory).not.toHaveBeenCalled();
  });

  it('never probes a not-ready Agent and guides to the Agents page', async () => {
    const onOpenAgents = vi.fn();
    mockLoadAgents.mockResolvedValue([makeAgent({
      id: 'agent-grok',
      name: 'Grok',
      proxy: 'grok',
      ready: false,
      cli: { state: 'missing', path: null, version: null, source: null },
    })]);

    renderView(onOpenAgents);
    expect(await screen.findByText('Agent not ready')).toBeInTheDocument();
    expect(mockInventory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open Agents' }));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('closes the detail at the event boundary when switching tabs', async () => {
    const item = skillItem();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [item]),
      mcp: kindResult('mcp', []),
    }));
    mockDetail.mockResolvedValue(detailText('skill', item.id, 'body'));

    renderView();
    await userEvent.click(await screen.findByTestId(`custom-row-${item.id}`));
    expect(await screen.findByTestId('custom-detail')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('custom-tab-mcp'));
    expect(screen.queryByTestId('custom-detail')).not.toBeInTheDocument();
  });

  it('keeps the chain ordinal out of the flex stretch (rule names stay left-aligned)', () => {
    // Regression (2026-09-06): `.custom-ord` is a direct-child span too, so
    // the blanket `> span { flex: 1 }` stretched the ordinal and shoved the
    // rule name to the middle of the row.
    const css = readFileSync('src/styles/custom.css', 'utf8');
    expect(css).toContain('.custom-1line .management-row-copy > span:not(.custom-ord)');
  });

  it('constrains panel 1 to the centered 820px content column', () => {
    // Owner request (2026-09-15): Custom panel 1 shares the chat panel-1
    // fixed-width column with the Agents and Timer pages.
    const css = readFileSync('src/styles/custom.css', 'utf8');
    const column = css.match(/\.custom-page-body > \*\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(column).toMatch(/max-width:\s*820px/);
    expect(column).toMatch(/margin-inline:\s*auto/);
    const head = css.match(/\.custom-page-head\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(head).toMatch(/height:\s*var\(--mgmt-header-h\)/);
  });

  it('renders the detail on the shared .p2 shell with a draggable seam', async () => {
    const item = skillItem();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [item]),
      mcp: kindResult('mcp', []),
    }));
    mockDetail.mockResolvedValue(detailText('skill', item.id, 'body'));

    renderView();
    await userEvent.click(await screen.findByTestId(`custom-row-${item.id}`));
    const detail = await screen.findByTestId('custom-detail');
    expect(detail.className).toContain('p2');
    // jsdom reports no measurable width, so the layout stays on the wide
    // side-by-side track and the seam is present.
    expect(document.querySelector('[data-panel-seam="main-panel2"]')).not.toBeNull();
    // The CSS clamp remains the baseline until the user drags.
    expect((detail as HTMLElement).style.width).toBe('');
  });

  it('closes the detail at the event boundary when switching Agents', async () => {
    const item = skillItem();
    mockLoadAgents.mockResolvedValue([
      makeAgent(),
      makeAgent({ id: 'agent-kimi', name: 'Kimi', proxy: 'kimi' }),
    ]);
    mockInventory
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', [item]) }))
      .mockReturnValue(new Promise(() => {})); // Kimi's load never settles
    mockDetail.mockResolvedValue(detailText('skill', item.id, 'body'));

    renderView();
    await userEvent.click(await screen.findByTestId(`custom-row-${item.id}`));
    expect(await screen.findByTestId('custom-detail')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Kimi/ }));
    // The detail is gone immediately — no stale frame pairs it with Kimi.
    expect(screen.queryByTestId('custom-detail')).not.toBeInTheDocument();
  });

  it('keeps the detail after refresh only while its stable ID survives', async () => {
    const item = skillItem();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', [item]) }))
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', [item]) })) // refresh: survives
      .mockResolvedValueOnce(inventory({ skill: kindResult('skill', []) }));    // refresh: gone
    mockDetail.mockResolvedValue(detailText('skill', item.id, 'body'));

    renderView();
    await userEvent.click(await screen.findByTestId(`custom-row-${item.id}`));
    expect(await screen.findByTestId('custom-detail')).toBeInTheDocument();

    // Refresh with the ID still listed: detail stays open.
    await userEvent.click(screen.getByTestId('custom-refresh'));
    await waitFor(() => expect(mockInventory).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('custom-detail')).toBeInTheDocument();

    // Refresh with the ID gone: detail closes.
    await userEvent.click(screen.getByTestId('custom-refresh'));
    await waitFor(() => expect(mockInventory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByTestId('custom-detail')).not.toBeInTheDocument());
  });

  it('groups rules into the effective chain (Global → Project → Subdirectory) and other discovered rules', async () => {
    // Wire order is the protocol's generic sort — directory first. Display
    // order must be Global → Project → Subdirectory with stable ordinals.
    const directory = ruleItem('subtree', 'AGENTS.md', 'directory', 'packages/host');
    const user = ruleItem('effective', 'AGENTS.md', 'user');
    const project = ruleItem('effective', 'AGENTS.md', 'workspace');
    const inactive = ruleItem('inactive', 'CLAUDE.md', 'workspace');
    const unreadable = ruleItem('unreadable', 'BROKEN.md', 'user');
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      rule: kindResult('rule', [directory, user, project, inactive, unreadable]),
    }));

    renderView();
    await userEvent.click(await screen.findByTestId('custom-tab-rule'));

    const chainGroup = (await screen.findByText('Effective chain')).closest('.management-group') as HTMLElement;
    const chainRows = within(chainGroup).getAllByRole('button');
    expect(chainRows).toHaveLength(3);
    expect(chainRows[0]).toHaveTextContent('#1');
    expect(chainRows[0]).toHaveTextContent('Global');
    expect(chainRows[0]).toHaveTextContent('Active');
    expect(chainRows[1]).toHaveTextContent('#2');
    expect(chainRows[1]).toHaveTextContent('Repo');
    expect(chainRows[2]).toHaveTextContent('#3');
    expect(chainRows[2]).toHaveTextContent('Subdirectory');
    expect(chainRows[2]).toHaveTextContent('Applies under packages/host');

    // Frozen vocabulary: unreadable/inactive both read as "Not active" — the
    // UI never introduces Unreadable/Configured/Unknown rule labels.
    const otherGroup = screen.getByText('Other discovered rules').closest('.management-group') as HTMLElement;
    const otherRows = within(otherGroup).getAllByRole('button');
    expect(otherRows).toHaveLength(2);
    for (const row of otherRows) expect(row).toHaveTextContent('Not active');
    expect(screen.queryByText('Unreadable')).not.toBeInTheDocument();
  });

  it('shows Configured instead of Enabled for configured-only completeness', async () => {
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({
      skill: kindResult('skill', [skillItem()], { completeness: 'configured' }),
    }));

    renderView();
    expect(await screen.findByText(/Showing configured entries/)).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });

  it('never offers Open in VS Code for a Global-scope Skill detail', async () => {
    const globalSkill = skillItem({
      scope: { level: 'user' },
      origin: { kind: 'user_file', path: '/home/me/.codex/skills/review-diff' },
    });
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({ skill: kindResult('skill', [globalSkill]) }));
    mockDetail.mockResolvedValue(detailText('skill', globalSkill.id, '# Review Diff'));

    renderView();
    await userEvent.click(await screen.findByTestId(`custom-row-${globalSkill.id}`));
    expect(await screen.findByTestId('custom-detail-text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).not.toBeInTheDocument();
  });

  it('shows MCP details as sanitized configuration and always Copy-only', async () => {
    const server = mcpItem();
    mockLoadAgents.mockResolvedValue([makeAgent()]);
    mockInventory.mockResolvedValue(inventory({ mcp: kindResult('mcp', [server]) }));
    mockDetail.mockResolvedValue(detailText('mcp', server.id, '{\n  "mcpServers": { "github": {} }\n}'));

    renderView();
    await userEvent.click(await screen.findByTestId('custom-tab-mcp'));
    await userEvent.click(await screen.findByTestId(`custom-row-${server.id}`));

    expect(await screen.findByText('Sanitized configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).not.toBeInTheDocument();
  });
});
