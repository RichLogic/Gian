// chat-ui tool/event rows: .trow grammar, threshold routing, running timers,
// and the event-line variants.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AgentSpawnRow,
  AutoNoticeCard,
  CommandCard,
  CompactionRow,
  DiffCard,
  FileReadCard,
  FileSearchCard,
  ReasoningCard,
  ToolEvent,
  WebSearchRow,
} from '../src/items.js';
import { EventLine, eventDetailText } from '../src/event-lines.js';
import { ChatPanelOpenContext, DiffOpenContext, FileLinkOpenContext } from '../src/contexts.js';
import type { AgentSpawnItem, AutoNoticeItem, CommandItem, DiffItem, ReasoningItem, ToolItem } from '../src/types.js';

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', id: 't-1', name: 'Bash', summary: '', status: 'success', ts: 1_000, turn: 1, ...overrides };
}
function cmd(overrides: Partial<CommandItem> = {}): CommandItem {
  return { kind: 'command', id: 'c-1', command: 'pnpm test', status: 'success', stdout: '', ts: 1_000, turn: 1, ...overrides };
}
function diffItem(files: number, hunkLines: number): DiffItem {
  return {
    kind: 'diff', id: 'd-1', ts: 1_000, turn: 1,
    files: Array.from({ length: files }, (_, f) => ({
      path: `f${f}.ts`, add: hunkLines, del: 0,
      hunks: [{ header: '@@ -1 +1 @@', lines: Array.from({ length: hunkLines }, (_, i) => ({ kind: 'add' as const, text: `+${i}` })) }],
    })),
  };
}

describe('trow grammar', () => {
  it('a row without detail has no caret and is not expandable', () => {
    const { container } = render(<ToolEvent item={tool()} />);
    const row = container.querySelector('.trow')!;
    expect(row.className).not.toContain('expandable');
    expect(container.querySelector('.trow-caret')).toBeNull();
  });

  it('error status renders in the right meta', () => {
    const { container } = render(<ToolEvent item={tool({ status: 'error' })} />);
    expect(container.querySelector('.trow-meta .err')!.textContent).toBe('error');
  });
});

describe('ToolEvent', () => {
  it('expands summary+output inline under the threshold', async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolEvent item={tool({ summary: '{"cmd":"ls"}', output: 'ok' })} />);
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelector('.tool-args')!.textContent).toContain('ls');
    expect(container.querySelector('.tool-output')!.textContent).toBe('ok');
  });

  it('routes over-threshold detail to the panel callback when mounted', async () => {
    const user = userEvent.setup();
    const openPanel = vi.fn();
    const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(
      <ChatPanelOpenContext.Provider value={openPanel}>
        <ToolEvent item={tool({ summary: '', output: big })} />
      </ChatPanelOpenContext.Provider>,
    );
    const row = container.querySelector('.trow')!;
    expect(row.className).toContain('clickable');
    await user.click(row);
    expect(openPanel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcript-detail' }));
    expect(container.querySelector('.trow-detail')).toBeNull();
  });

  it('over-threshold detail still expands inline (scroll-capped) without a panel', async () => {
    const user = userEvent.setup();
    const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(<ToolEvent item={tool({ summary: '', output: big })} />);
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelector('.trow-detail.scroll')).not.toBeNull();
  });
});

describe('CommandCard', () => {
  it('running commands tick the live timer and stream with a cursor', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CommandCard item={cmd({ status: 'running', stdout: 'partial\n', ts: Date.now() - 3_000 })} />,
    );
    expect(container.querySelector('.trow-run')!.textContent).toMatch(/running · [23]s/);
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelector('.cmd-stream .cmd-cursor')).not.toBeNull();
  });

  it('a terminal turn never ticks a live timer', () => {
    const { container } = render(<CommandCard item={cmd({ status: 'running' })} turnCompleted />);
    expect(container.querySelector('.trow-run')).toBeNull();
  });

  it('failed commands show error + exit code meta', () => {
    const { container } = render(<CommandCard item={cmd({ status: 'error', exitCode: 2, stdout: 'x' })} />);
    expect(container.querySelector('.trow-meta')!.textContent).toContain('exit 2');
  });
});

describe('DiffCard', () => {
  it('a small single-file diff expands inline as a mini diff', async () => {
    const user = userEvent.setup();
    const { container } = render(<DiffCard item={diffItem(1, 4)} />);
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelectorAll('.trow-detail.diff .dline.add')).toHaveLength(4);
  });

  it('a multi-file diff clicks through to the app detail surface', async () => {
    const user = userEvent.setup();
    const openDiff = vi.fn();
    const item = diffItem(3, 4);
    const { container } = render(
      <DiffOpenContext.Provider value={openDiff}>
        <DiffCard item={item} />
      </DiffOpenContext.Provider>,
    );
    const row = container.querySelector('.trow')!;
    expect(row.className).toContain('clickable');
    expect(row.textContent).toContain('Changed files 3');
    await user.click(row);
    expect(openDiff).toHaveBeenCalledWith(item);
  });
});

describe('file/search rows', () => {
  it('FileReadCard renders path + line range as a file link', () => {
    const open = vi.fn();
    const { container } = render(
      <FileLinkOpenContext.Provider value={open}>
        <FileReadCard item={{ kind: 'file-read', id: 'fr-1', path: '/w/a.ts', startLine: 40, endLine: 120, ts: 1, turn: 1 }} />
      </FileLinkOpenContext.Provider>,
    );
    const link = container.querySelector('.trow-subject a.file-link')!;
    expect(link.textContent).toBe('/w/a.ts :40–120');
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith('/w/a.ts', 40);
  });

  it('FileSearchCard expands short match lists inline', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FileSearchCard item={{ kind: 'file-search', id: 'fs-1', pattern: 'foo', searchKind: 'grep', matches: ['a.ts', 'b.ts'], ts: 1, turn: 1 }} />,
    );
    expect(container.querySelector('.trow-meta')!.textContent).toContain('2 matches');
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelectorAll('.search-result')).toHaveLength(2);
  });

  it('WebSearchRow renders the query with a result count', () => {
    const { container } = render(
      <WebSearchRow item={{ kind: 'web-search', id: 'ws-1', query: 'gian', resultCount: 5, ts: 1, turn: 1 }} />,
    );
    expect(container.querySelector('.trow')!.textContent).toContain('gian');
    expect(container.querySelector('.trow-meta')!.textContent).toContain('5 results');
  });
});

describe('ReasoningCard', () => {
  const base: ReasoningItem = { kind: 'reasoning', id: 'r-1', text: 'thinking\nstep 2', variant: 'summary', ts: 1, turn: 1 };
  it('renders the summary label and expands the trace', async () => {
    const user = userEvent.setup();
    const { container } = render(<ReasoningCard item={base} />);
    expect(container.querySelector('.trow-verb')!.textContent).toBe('Reasoning summary');
    await user.click(container.querySelector('.trow')!);
    expect(container.querySelector('.trow-detail')!.textContent).toContain('step 2');
  });
  it('full variant uses the full label', () => {
    const { container } = render(<ReasoningCard item={{ ...base, variant: 'full' }} />);
    expect(container.querySelector('.trow-verb')!.textContent).toBe('Reasoning');
  });
});

describe('AgentSpawnRow', () => {
  const agent: AgentSpawnItem = {
    kind: 'agent-spawn', id: 'ag-1', provider: 'claude', description: 'explore repo',
    status: 'running', startedAt: 1, updatedAt: 1, ts: Date.now() - 2_000, turn: 1,
  };
  it('running agents tick and click through to the agent panel', async () => {
    const user = userEvent.setup();
    const openPanel = vi.fn();
    const { container } = render(
      <ChatPanelOpenContext.Provider value={openPanel}>
        <AgentSpawnRow item={agent} />
      </ChatPanelOpenContext.Provider>,
    );
    expect(container.querySelector('.trow-run')).not.toBeNull();
    await user.click(container.querySelector('.trow')!);
    expect(openPanel).toHaveBeenCalledWith({ kind: 'agent', id: '1:agent-spawn:ag-1' });
  });
  it('a stale running row on a completed turn reads interrupted', () => {
    const { container } = render(<AgentSpawnRow item={agent} turnCompleted />);
    expect(container.querySelector('.trow-run')).toBeNull();
    expect(container.textContent).toContain('Interrupted');
  });
});

describe('AutoNoticeCard + CompactionRow', () => {
  const notice: AutoNoticeItem = {
    kind: 'auto-notice', id: 'n-1', variant: 'classifier-denied', action: 'Bash(rm -rf)',
    reason: 'destructive', consecutive: 2, total: 5, ts: 1, turn: 1,
  };
  it('classifier-denied renders a single trow with counters', () => {
    const { container } = render(<AutoNoticeCard item={notice} />);
    expect(container.querySelector('.trow-verb')!.textContent).toBe('Auto-block');
    expect(container.querySelector('.trow-meta')!.textContent).toBe('2/3 · 5 total');
  });
  it('circuit-breaker renders the minimal error card', () => {
    const { container } = render(
      <AutoNoticeCard item={{ ...notice, variant: 'circuit-breaker', trigger: 'consecutive', consecutive: 3 }} />,
    );
    expect(container.querySelector('.approval .error-label')!.textContent).toBe('AUTO-MODE STOPPED');
  });
  it('error-severity notice renders as an error card; info as a row', () => {
    const err = render(<AutoNoticeCard item={{ ...notice, variant: 'notice', severity: 'error', title: 'Boom', message: 'bad' }} />);
    expect(err.container.querySelector('.error-label')!.textContent).toBe('Boom');
    err.unmount();
    const info = render(<AutoNoticeCard item={{ ...notice, variant: 'notice', severity: 'info', title: 'FYI', message: 'ok' }} />);
    expect(info.container.querySelector('.trow-verb')!.textContent).toBe('FYI');
  });
  it('compaction renders the token delta', () => {
    const { container } = render(
      <CompactionRow item={{ kind: 'compaction', id: 'cp-1', beforeTokens: 128_000, afterTokens: 41_000, ts: 1, turn: 1 }} />,
    );
    expect(container.querySelector('.trow')!.textContent).toContain('context compacted · 128k → 41k');
  });
});

describe('EventLine', () => {
  it('renders bare rows without expand/click behavior', () => {
    const { container } = render(<EventLine item={tool()} />);
    const row = container.querySelector('.trow')!;
    expect(row.className).not.toContain('expandable');
    expect(row.className).not.toContain('clickable');
  });

  it('resolved approvals render as one-line summaries', () => {
    const { container } = render(
      <EventLine item={{
        kind: 'approval', id: 'ap-1', approvalId: 'ap-1', title: 'Bash', reason: '', cmd: 'ls',
        risk: 'low', status: 'approved-once', ts: 1, turn: 1,
      }} />,
    );
    expect(container.querySelector('.approval-line .al-mark.ok')).not.toBeNull();
    expect(container.querySelector('.approval-line')!.textContent).toContain('Allowed once');
  });

  it('eventDetailText prefers structured payloads, falls back to JSON, and stays null for resolved approvals', () => {
    expect(eventDetailText(cmd({ stdout: 'hi' }))).toContain('$ pnpm test');
    expect(eventDetailText(tool({ summary: '{"a":1}' }))).toContain('"a": 1');
    expect(eventDetailText({
      kind: 'approval', id: 'ap-1', approvalId: 'ap-1', title: 'Bash', reason: '', cmd: 'ls',
      risk: 'low', status: 'declined', ts: 1, turn: 1,
    })).toBeNull();
  });
});
