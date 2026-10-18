/**
 * Conversation find (Issue #168 / 0.6.7): Cmd/Ctrl+F scoping guards,
 * Host-find counts and navigation, bounded context loads for unloaded
 * matches, partial labels, Esc focus restore, streaming drift, and the
 * canonical-offset highlight mapping (real chat-ui message renderers; ranges
 * computed through the shared findLiteralRanges, never hand-written).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import type { ComposerDocument, FindMatch } from '@gian/shared';
import type { TranscriptHistoryState } from '../src/controllers/use-transcript-hydration.js';
import { findLiteralRanges, projectComposerSearchText, projectSearchText } from '@gian/shared';
import { AssistantMessage, UserMessage } from '@gian/chat-ui';
import type { MsgItem } from '@gian/chat-ui';
import { ConversationFind } from '../src/transcript/ConversationFind.js';
import { mockFetch } from './setup.js';

// jsdom lacks the CSS Custom Highlight API and scrollIntoView.
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}
const highlightRegistry = new Map<string, FakeHighlight>();
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { highlights: highlightRegistry, escape: (value: string) => value.replace(/"/g, '\\"') },
});
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function msg(id: string, kind: 'user' | 'assistant', turn: number, text: string, extra: Partial<MsgItem> = {}): MsgItem {
  return { kind, id, text, exec: 'claude', ts: turn, turn, ...extra };
}

/** The Host match range for a fixture, computed exactly like the index. */
function hostMatch(id: string, documentId: string, item: MsgItem, query: string, occurrence = 0): FindMatch {
  const projected = item.kind === 'user' && item.composerDocument
    ? projectComposerSearchText(item.composerDocument)
    : projectSearchText(item.text);
  const range = findLiteralRanges(projected, query)[occurrence]!;
  return {
    id,
    document_id: documentId,
    target: {
      type: 'session',
      session_id: 's-1',
      turn_id: `turn-${item.turn}`,
      turn: item.turn,
      message_id: `${item.turn}:${item.kind}:${item.id}`,
      message_kind: item.kind,
      text_revision: 'a'.repeat(64),
      archived: false,
    },
    range,
    snippet: projected.slice(Math.max(0, range.start - 8), range.end + 8),
  };
}

function findPage(matches: FindMatch[], options: { total?: number; complete?: boolean; cursor?: string | null } = {}) {
  return {
    matches,
    next_cursor: options.cursor ?? null,
    query_revision: 'qr-1',
    total: options.total ?? matches.length,
    total_complete: options.complete ?? true,
    coverage: { state: options.complete === false ? 'partial' : 'ready', complete: options.complete ?? true, indexed: 10, pending: 0 },
  };
}

/** Bumps the streaming signal without changing the mounted transcript. */
function DriftFind({ items }: { items: MsgItem[] }) {
  const [signal, setSignal] = useState('settled');
  return (
    <>
      <button type="button" data-testid="find-drift" onClick={() => setSignal(current => `${current}+`)}>
        drift
      </button>
      <Harness items={items} contentSignal={signal} />
    </>
  );
}

function Harness({ items, onLoadMessageContext, contentSignal, history }: {
  items: MsgItem[];
  onLoadMessageContext?: (request: { turnId?: string; turn?: number; documentId?: string; textRevision?: string }) => Promise<boolean>;
  contentSignal?: string;
  history?: TranscriptHistoryState;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  return (
    <div className="main">
      <div className="main-scroll" ref={scopeRef}>
        {items.map(item => item.kind === 'user'
          ? <UserMessage key={item.id} item={item} />
          : <AssistantMessage key={item.id} item={item} />)}
      </div>
      <ConversationFind
        sessionId="s-1"
        scopeRef={scopeRef}
        items={items}
        history={history}
        contentSignal={contentSignal}
        onLoadMessageContext={onLoadMessageContext}
        onActiveChange={() => {}}
      />
    </div>
  );
}

function findRouter(page: ReturnType<typeof findPage>) {
  const calls: string[] = [];
  mockFetch(async input => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url.includes('/find')) return Response.json(page);
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  return calls;
}

const TEXT_PLAN = msg('m-1', 'user', 1, 'plan the release');
const TEXT_ANSWER = msg('m-2', 'assistant', 2, 'the plan is ready');

describe('ConversationFind', () => {
  beforeEach(() => highlightRegistry.clear());
  afterEach(() => vi.restoreAllMocks());

  async function openFind(user: ReturnType<typeof userEvent.setup>) {
    await user.keyboard('{Meta>}f{/Meta}');
    return screen.findByTestId('conversation-find');
  }

  it('Cmd+F opens over the conversation; Esc closes and clears highlights', async () => {
    findRouter(findPage([]));
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('conversation-find')).toBeNull());
    expect(highlightRegistry.has('gian-find')).toBe(false);
  });

  it('Composer focus still opens conversation find; an editable outside the conversation keeps its own', async () => {
    findRouter(findPage([]));
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    const composer = document.createElement('textarea');
    document.querySelector('.main')!.appendChild(composer);
    composer.focus();
    await openFind(user);
    composer.remove();
    await user.keyboard('{Escape}');
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    await user.keyboard('{Meta>}f{/Meta}');
    expect(screen.queryByTestId('conversation-find')).toBeNull();
    outside.remove();
  });

  it('an open dialog blocks the find shortcut', async () => {
    findRouter(findPage([]));
    render(<Harness items={[]} />);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}f{/Meta}');
    expect(screen.queryByTestId('conversation-find')).toBeNull();
    dialog.remove();
  });

  it('queries the Host find API and shows exact counts with wrap-around', async () => {
    const matches = [
      hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan'),
      hostMatch('occ-2', 'doc-2', TEXT_ANSWER, 'plan'),
    ];
    const calls = findRouter(findPage(matches, { total: 2 }));
    render(<Harness items={[TEXT_PLAN, TEXT_ANSWER]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    expect(await screen.findByTestId('conversation-find-count')).toHaveTextContent('1 / 2');
    expect(calls.some(url => url.includes('/api/sessions/s-1/find') && url.includes('q=plan'))).toBe(true);
    // Both loaded matches highlighted through canonical ranges; active distinct.
    await waitFor(() => expect(highlightRegistry.get('gian-find')?.ranges.length).toBe(2));
    expect(highlightRegistry.get('gian-find-active')?.ranges.length).toBe(1);
    expect(highlightRegistry.get('gian-find-active')?.ranges[0]?.toString()).toBe('plan');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
  });

  it('maps the exact canonical offset — the second identical hit maps to the second occurrence', async () => {
    const item = msg('m-1', 'assistant', 1, 'plan a then plan b');
    const matches = [
      hostMatch('occ-1', 'doc-1', item, 'plan', 0),
      hostMatch('occ-2', 'doc-1', item, 'plan', 1),
    ];
    findRouter(findPage(matches, { total: 2 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await screen.findByTestId('conversation-find-count');
    await waitFor(() => expect(highlightRegistry.get('gian-find')?.ranges.length).toBe(2));
    // Advance to the second hit: its range covers the SECOND "plan".
    await user.keyboard('{Enter}');
    await waitFor(() => {
      const active = highlightRegistry.get('gian-find-active')?.ranges[0];
      expect(active?.toString()).toBe('plan');
      expect(active?.startOffset).toBeGreaterThan(0);
    });
  });

  it('labels incomplete counts instead of pretending exhaustiveness', async () => {
    findRouter(findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 5, complete: false }));
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    expect(await screen.findByTestId('conversation-find-count')).toHaveTextContent('1 / 5+');
    expect(screen.getByText('Partial')).toBeTruthy();
  });

  it('an unloaded match hydrates its bounded context window', async () => {
    const match = hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan');
    findRouter(findPage([match]));
    const onLoadMessageContext = vi.fn(async () => true);
    render(<Harness items={[]} onLoadMessageContext={onLoadMessageContext} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await screen.findByTestId('conversation-find-count');
    await waitFor(() => expect(onLoadMessageContext).toHaveBeenCalledWith({
      turnId: 'turn-1',
      turn: 1,
      documentId: 'doc-1',
      textRevision: 'a'.repeat(64),
    }));
  });

  it('a stale indexed range re-queries instead of highlighting a guess', async () => {
    // The indexed range no longer selects the query in the live text.
    const staleMatch = hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan');
    staleMatch.range = { start: 5, end: 12 };
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return Response.json(findPage([staleMatch], { total: 1 }));
    });
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    // Nothing was ever highlighted from the stale range.
    expect(highlightRegistry.get('gian-find-active') ?? undefined).toBeUndefined();
  });

  it('reference chip labels map through the composer document projection', async () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        { type: 'text', text: 'deploy with ' },
        { type: 'reference', id: 'ref-1', referenceType: 'context', label: 'release-plan.md', kind: 'file' },
        { type: 'text', text: ' tonight' },
      ],
    };
    const item = msg('m-1', 'user', 1, '', { composerDocument: document });
    const match = hostMatch('occ-1', 'doc-1', item, 'release-plan');
    findRouter(findPage([match], { total: 1 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'release-plan');
    await screen.findByTestId('conversation-find-count');
    await waitFor(() => {
      const active = highlightRegistry.get('gian-find-active')?.ranges[0];
      expect(active?.toString()).toBe('release-plan');
    });
  });

  it('copy buttons are never a match; code body text is', async () => {
    const item = msg('m-1', 'assistant', 1, '```ts\ncopy now\n```');
    const match = hostMatch('occ-1', 'doc-1', item, 'copy');
    findRouter(findPage([match], { total: 1 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'copy');
    await screen.findByTestId('conversation-find-count');
    // The hit is the code body, not the Copy button label.
    await waitFor(() => {
      const active = highlightRegistry.get('gian-find-active')?.ranges[0];
      expect(active?.toString()).toBe('copy');
      expect(active?.startContainer.parentElement?.closest('button')).toBeNull();
    });
  });

  it('an empty first page with a live cursor keeps scanning on demand', async () => {
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('cursor=c2')) {
        return Response.json(findPage([hostMatch('occ-2', 'doc-1', TEXT_PLAN, 'plan')], { total: 1 }));
      }
      return Response.json(findPage([], { total: 0, complete: false, cursor: 'c2' }));
    });
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    expect(await screen.findByTestId('conversation-find-count')).toHaveTextContent('0 / 0+');
    const next = screen.getByTestId('conversation-find-next');
    expect(next).not.toBeDisabled();
    await user.click(next);
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1'));
  });

  it('a stale find cursor re-queries from the top', async () => {
    let topCalls = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('cursor=dead')) {
        return Response.json({ error: { code: 'stale_cursor', message: 'stale' } }, { status: 409 });
      }
      topCalls += 1;
      return Response.json(topCalls === 1
        ? findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 3, cursor: 'dead' })
        : findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 1 }));
    });
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await screen.findByTestId('conversation-find-count');
    await user.click(screen.getByTestId('conversation-find-next'));
    await vi.waitFor(() => expect(topCalls).toBe(2));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
  });

  it('a find error shows retry and recovers', async () => {
    let fail = true;
    mockFetch(async () => {
      if (fail) return Response.json({ error: { code: 'invalid_argument', message: 'x' } }, { status: 500 });
      return Response.json(findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 1 }));
    });
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    expect(await screen.findByTestId('conversation-find-error')).toBeTruthy();
    fail = false;
    await user.click(screen.getByTestId('conversation-find-error'));
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1'));
  });

  it('a new query clears old matches — the stale page is never navigated', async () => {
    let resolveSecond: ((r: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('q=one&') || url.endsWith('q=one')) {
        return Response.json(findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 1 }));
      }
      return new Promise<Response>(resolve => { resolveSecond = resolve; });
    });
    render(<Harness items={[TEXT_PLAN]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'one');
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1'));
    await user.type(screen.getByPlaceholderText(/Find in conversation/), ' two');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('…');
    resolveSecond!(Response.json(findPage([], { total: 0 })));
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('0 / 0'));
  });

  it('a same-query refresh preserves the active match by identity', async () => {
    const matches = [
      hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan'),
      hostMatch('occ-2', 'doc-2', TEXT_ANSWER, 'plan'),
    ];
    findRouter(findPage(matches, { total: 2 }));
    const { rerender } = render(<Harness items={[TEXT_PLAN, TEXT_ANSWER]} contentSignal="2:16" />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await screen.findByTestId('conversation-find-count');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
    // Streaming drift: same query re-runs, the active hit stays the second.
    rerender(<Harness items={[TEXT_PLAN, TEXT_ANSWER]} contentSignal="2:21" />);
    await vi.waitFor(() => expect(highlightRegistry.get('gian-find-active')?.ranges.length).toBe(1));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
  });

  it('streaming content drift re-runs the open query (counts stay honest)', async () => {
    const calls = findRouter(findPage([hostMatch('occ-1', 'doc-1', TEXT_PLAN, 'plan')], { total: 1 }));
    const { rerender } = render(<Harness items={[TEXT_PLAN]} contentSignal="1:16" />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'plan');
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1'));
    const callsBefore = calls.length;
    rerender(<Harness items={[msg('m-1', 'user', 1, 'plan the release soon')]} contentSignal="1:21" />);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(callsBefore));
  });

  it('an atomic (math) hit shows the explicit marker and clears it on close', async () => {
    const item = msg('m-math', 'assistant', 3, 'energy is $E=mc^2$ exactly');
    const match = hostMatch('occ-math', 'doc-math', item, 'E=mc^2');
    findRouter(findPage([match], { total: 1 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'E=mc^2');
    // The active atomic hit shows the visible outline marker — not a hidden
    // MathML annotation highlight.
    expect(await screen.findByTestId('find-atomic-active')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('find-atomic-active')).toBeNull());
  });

  it('the atomic marker lives in the scroller content space and is measured after reveal', async () => {
    const item = msg('m-math', 'assistant', 3, 'energy is $E=mc^2$ exactly');
    const match = hostMatch('occ-math', 'doc-math', item, 'E=mc^2');
    findRouter(findPage([match], { total: 1 }));
    const rectFor = (top: number, left: number, width: number, height: number) => ({
      top, left, width, height,
      right: left + width, bottom: top + height, x: left, y: top,
      toJSON: () => ({}),
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('katex')) return rectFor(100, 20, 40, 10) as DOMRect;
        if (this.classList.contains('main-scroll')) return rectFor(50, 0, 800, 600) as DOMRect;
        return rectFor(0, 0, 0, 0) as DOMRect;
      });
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'E=mc^2');
    const marker = await screen.findByTestId('find-atomic-active');
    const scope = document.querySelector('.main-scroll')!;
    // Inside the scroller (follows content on manual scroll), measured from
    // the element's rect in content coordinates.
    expect(marker.parentElement).toBe(scope);
    expect((marker as HTMLElement).style.top).toBe('50px');
    expect((marker as HTMLElement).style.left).toBe('20px');
    expect((marker as HTMLElement).style.width).toBe('40px');
    expect((marker as HTMLElement).style.height).toBe('10px');
    rectSpy.mockRestore();
  });

  it('the atomic marker never feeds the transcript observer back into a loop', async () => {
    const item = msg('m-math', 'assistant', 3, 'energy is $E=mc^2$ exactly');
    const match = hostMatch('occ-math', 'doc-math', item, 'E=mc^2');
    findRouter(findPage([match], { total: 1 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'E=mc^2');
    await screen.findByTestId('find-atomic-active');
    // After the initial placement: no further rAF scheduling, no marker churn.
    const scope = document.querySelector('.main-scroll')!;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const appendSpy = vi.spyOn(scope, 'appendChild');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(rafSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.find-atomic-active')).toHaveLength(1);
    // A REAL content change still re-scans (the observer is not deaf) —
    // including in-place text edits (characterData, not new nodes).
    const textNode = scope.querySelector('[data-transcript-source-id]')!
      .querySelector('p')!.firstChild as Text;
    textNode.data = 'plan the release soon';
    await vi.waitFor(() => expect(rafSpy.mock.calls.length).toBeGreaterThan(0));
    rafSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('Back to latest keeps the query and does not load the old hit until Next', async () => {
    const historyItem = msg('m-old', 'user', 4, 'span.ri-title in history');
    const tailItem = msg('m-tail', 'assistant', 9, 'the latest tail');
    const match = hostMatch('occ-1', 'doc-1', historyItem, 'span.ri-title');
    findRouter(findPage([match], { total: 1 }));
    const onLoad = vi.fn(async () => true);
    function ReturnHarness() {
      const [detached, setDetached] = useState(true);
      const [generation, setGeneration] = useState(0);
      const [items, setItems] = useState<MsgItem[]>([historyItem]);
      const history: TranscriptHistoryState = {
        phase: 'page',
        hasMore: false,
        loading: false,
        loadingOlder: false,
        cursor: null,
        error: null,
        detachedFromLatest: detached,
        returnToLatestGeneration: generation,
      };
      return (
        <>
          <Harness items={items} history={history} onLoadMessageContext={onLoad} />
          <button
            type="button"
            data-testid="return-to-latest"
            onClick={() => {
              setGeneration(value => value + 1);
              setDetached(false);
              setItems([tailItem]);
            }}
          >
            Back to latest
          </button>
        </>
      );
    }
    render(<ReturnHarness />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    expect(await screen.findByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect(screen.getByText('Viewing a history window')).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('return-to-latest'));
    expect(screen.queryByText('Viewing a history window')).toBeNull();
    expect(screen.getByText('the latest tail')).toBeTruthy();
    await actDelay(80);
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');

    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(onLoad).toHaveBeenCalledWith({
      turnId: 'turn-4',
      turn: 4,
      documentId: 'doc-1',
      textRevision: 'a'.repeat(64),
    });
  });

  it('restores Find focus after an in-flight context load replaces the transcript', async () => {
    const first = msg('m-1', 'user', 1, 'alpha plan');
    const second = msg('m-2', 'assistant', 2, 'beta plan');
    findRouter(findPage([
      hostMatch('occ-1', 'doc-1', first, 'plan'),
      hostMatch('occ-2', 'doc-2', second, 'plan'),
    ], { total: 2 }));
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const onLoad = vi.fn(() => gate);
    const view = render(<Harness items={[]} onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    const input = screen.getByPlaceholderText(/Find in conversation/);
    await user.type(input, 'plan');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2');
    input.blur();
    expect(document.activeElement).not.toBe(input);

    release(true);
    view.rerender(<Harness items={[first, second]} onLoadMessageContext={onLoad} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText(/Find in conversation/)));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
  });

  it('does not pull Find focus back after the user leaves the find bar', async () => {
    const first = msg('m-1', 'user', 1, 'alpha plan');
    const second = msg('m-2', 'assistant', 2, 'beta plan');
    findRouter(findPage([
      hostMatch('occ-1', 'doc-1', first, 'plan'),
      hostMatch('occ-2', 'doc-2', second, 'plan'),
    ], { total: 2 }));
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const onLoad = vi.fn(() => gate);
    const view = render(<Harness items={[]} onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    const input = screen.getByPlaceholderText(/Find in conversation/);
    await user.type(input, 'plan');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    // A click on a surface that does not take focus (Browser page, a blank
    // region) blurs Find onto the document. That must not be treated as the
    // transcript swap that restores the caret.
    const surface = document.createElement('div');
    surface.setAttribute('data-testid', 'browser-surface');
    document.body.appendChild(surface);
    surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.blur();
    expect(document.activeElement).not.toBe(input);

    release(true);
    view.rerender(<Harness items={[first, second]} onLoadMessageContext={onLoad} />);
    await actDelay(50);
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText(/Find in conversation/));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2');
    surface.remove();
  });

  it('a deferred context load does not reload or refetch after Back to latest', async () => {
    const historyItem = msg('m-old', 'user', 4, 'span.ri-title in history');
    const tailItem = msg('m-tail', 'assistant', 9, 'the latest tail');
    const match = hostMatch('occ-1', 'doc-1', historyItem, 'span.ri-title');
    const calls = findRouter(findPage([match], { total: 1 }));
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const onLoad = vi.fn(() => gate);
    function DeferredReturn() {
      const [generation, setGeneration] = useState(0);
      const [detached, setDetached] = useState(true);
      const [items, setItems] = useState<MsgItem[]>([]);
      const history: TranscriptHistoryState = {
        phase: 'page',
        hasMore: false,
        loading: false,
        loadingOlder: false,
        cursor: null,
        error: null,
        detachedFromLatest: detached,
        returnToLatestGeneration: generation,
      };
      return (
        <>
          <Harness items={items} history={history} onLoadMessageContext={onLoad} />
          <button
            type="button"
            data-testid="return-to-latest"
            onClick={() => {
              setGeneration(value => value + 1);
              setDetached(false);
              setItems([tailItem]);
            }}
          >
            Back to latest
          </button>
        </>
      );
    }
    render(<DeferredReturn />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    const findsBeforeReturn = calls.length;

    await user.click(screen.getByTestId('return-to-latest'));
    expect(screen.queryByText('Viewing a history window')).toBeNull();
    expect(screen.getByText('the latest tail')).toBeTruthy();
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');

    release(true);
    await actDelay(80);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(findsBeforeReturn);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect((screen.getByPlaceholderText(/Find in conversation/) as HTMLInputElement).value).toBe('span.ri-title');

    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    expect(onLoad).toHaveBeenLastCalledWith({
      turnId: 'turn-4',
      turn: 4,
      documentId: 'doc-1',
      textRevision: 'a'.repeat(64),
    });
  });

  it('a late false from a deferred context load does not refetch after Back to latest', async () => {
    const historyItem = msg('m-old', 'user', 4, 'span.ri-title in history');
    const tailItem = msg('m-tail', 'assistant', 9, 'the latest tail');
    const match = hostMatch('occ-1', 'doc-1', historyItem, 'span.ri-title');
    const calls = findRouter(findPage([match], { total: 1 }));
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const onLoad = vi.fn(() => gate);
    function DeferredReturn() {
      const [generation, setGeneration] = useState(0);
      const [detached, setDetached] = useState(true);
      const [items, setItems] = useState<MsgItem[]>([]);
      const history: TranscriptHistoryState = {
        phase: 'page',
        hasMore: false,
        loading: false,
        loadingOlder: false,
        cursor: null,
        error: null,
        detachedFromLatest: detached,
        returnToLatestGeneration: generation,
      };
      return (
        <>
          <Harness items={items} history={history} onLoadMessageContext={onLoad} />
          <button
            type="button"
            data-testid="return-to-latest"
            onClick={() => {
              setGeneration(value => value + 1);
              setDetached(false);
              setItems([tailItem]);
            }}
          >
            Back to latest
          </button>
        </>
      );
    }
    render(<DeferredReturn />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    const findsBeforeReturn = calls.length;
    await user.click(screen.getByTestId('return-to-latest'));
    release(false);
    await actDelay(80);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(findsBeforeReturn);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect((screen.getByPlaceholderText(/Find in conversation/) as HTMLInputElement).value).toBe('span.ri-title');

    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
  });

  it('a late context load cannot release the newer load of the same match', async () => {
    const historyItem = msg('m-old', 'user', 4, 'span.ri-title in history');
    const tailItem = msg('m-tail', 'assistant', 9, 'the latest tail');
    const match = hostMatch('occ-1', 'doc-1', historyItem, 'span.ri-title');
    const calls = findRouter(findPage([match], { total: 1 }));
    const releases: Array<(ok: boolean) => void> = [];
    const onLoad = vi.fn(() => new Promise<boolean>(resolve => { releases.push(resolve); }));
    function DeferredReturn() {
      const [generation, setGeneration] = useState(0);
      const [detached, setDetached] = useState(true);
      const [items, setItems] = useState<MsgItem[]>([]);
      const history: TranscriptHistoryState = {
        phase: 'page',
        hasMore: false,
        loading: false,
        loadingOlder: false,
        cursor: null,
        error: null,
        detachedFromLatest: detached,
        returnToLatestGeneration: generation,
      };
      return (
        <>
          <Harness items={items} history={history} onLoadMessageContext={onLoad} />
          <button
            type="button"
            data-testid="return-to-latest"
            onClick={() => {
              setGeneration(value => value + 1);
              setDetached(false);
              setItems([tailItem]);
            }}
          >
            Back to latest
          </button>
          <button type="button" data-testid="show-target" onClick={() => setItems([historyItem])}>
            Show target
          </button>
        </>
      );
    }
    render(<DeferredReturn />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    const findsAfterFirst = calls.length;

    await user.click(screen.getByTestId('return-to-latest'));
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    expect(releases).toHaveLength(2);

    releases[0]!(false);
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(findsAfterFirst);
    await flushTranscriptDomTick();
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect((screen.getByPlaceholderText(/Find in conversation/) as HTMLInputElement).value).toBe('span.ri-title');

    await user.click(screen.getByTestId('show-target'));
    await waitFor(() => {
      expect(highlightRegistry.get('gian-find-active')?.ranges[0]?.toString()).toBe('span.ri-title');
    });
    releases[1]!(true);
    await act(async () => { await Promise.resolve(); });
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(calls.length).toBe(findsAfterFirst);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect(highlightRegistry.get('gian-find-active')?.ranges[0]?.toString()).toBe('span.ri-title');
  });

  it('a late query generation cannot unlock or block the load for the edited query', async () => {
    const item = msg('m-old', 'user', 4, 'span.ri-title in history');
    const match = hostMatch('occ-1', 'doc-1', item, 'span');
    const calls = findRouter(findPage([match], { total: 1 }));
    const releases: Array<(ok: boolean) => void> = [];
    const onLoad = vi.fn(() => new Promise<boolean>(resolve => { releases.push(resolve); }));
    const view = render(<Harness items={[]} onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    const input = screen.getByPlaceholderText(/Find in conversation/);
    await user.type(input, 'Span');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    await user.clear(input);
    await user.type(input, 'span');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    const findsAfterEdit = calls.length;
    releases[0]!(true);
    await act(async () => { await Promise.resolve(); });
    await flushTranscriptDomTick();
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(calls.length).toBe(findsAfterEdit);
    expect((input as HTMLInputElement).value).toBe('span');

    view.rerender(<Harness items={[item]} onLoadMessageContext={onLoad} />);
    await waitFor(() => {
      expect(highlightRegistry.get('gian-find-active')?.ranges[0]?.toString()).toBe('span');
    });
    releases[1]!(true);
    await act(async () => { await Promise.resolve(); });
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
    expect((input as HTMLInputElement).value).toBe('span');
  });

  it('a superseded context load releases its own slot so a refresh can retry', async () => {
    const item = msg('m-old', 'user', 4, 'span.ri-title in history');
    const match = hostMatch('occ-1', 'doc-1', item, 'span.ri-title');
    const calls = findRouter(findPage([match], { total: 1 }));
    let release!: (ok: boolean) => void;
    const onLoad = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const view = render(<Harness items={[]} contentSignal="1" onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    const findsBeforeRefresh = calls.length;

    view.rerender(<Harness items={[]} contentSignal="2" onLoadMessageContext={onLoad} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(findsBeforeRefresh));
    await act(async () => { await Promise.resolve(); });
    expect(onLoad).toHaveBeenCalledTimes(1);
    const findsAfterRefresh = calls.length;

    release(false);
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(findsAfterRefresh);
    await flushTranscriptDomTick();
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
  });

  it('a late failure from the previous page cannot refetch over the match Next selected', async () => {
    const itemA = msg('m-a', 'user', 4, 'alpha find-token in the first hit');
    const itemB = msg('m-b', 'user', 8, 'beta find-token in the second hit');
    const { calls, releases, onLoad, PagedLocate } = pagedLocateFixture(
      itemA,
      itemB,
      hostMatch('occ-a', 'doc-a', itemA, 'find-token'),
      hostMatch('occ-b', 'doc-b', itemB, 'find-token'),
    );
    render(<PagedLocate />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'find-token');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2');

    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    expect(onLoad.mock.calls.map(call => call[0].turn)).toEqual([itemA.turn, itemB.turn]);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
    const findsBeforeLate = calls.length;

    await act(async () => {
      releases[0]!(false);
      await Promise.resolve();
    });
    expect(countFindCalls(calls, false)).toBe(1);
    expect(calls.length).toBe(findsBeforeLate);
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
    expect(screen.queryByText(/alpha find-token/)).toBeNull();

    await act(async () => {
      releases[1]!(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(activeFindMessageId()).toBe(messageIdentity(itemB)));
    expect(screen.getByText(/beta find-token in the second hit/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 3'));
    expect(countFindCalls(calls, false)).toBe(2);
    expect(calls.filter(url => url.includes('cursor=page-2'))).toHaveLength(1);
    expect(calls.filter(url => url.includes('cursor=fresh-b'))).toHaveLength(1);
    expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    expect(onLoad.mock.calls.map(call => call[0].turn)).toEqual([itemA.turn, itemB.turn]);
    expect(screen.getByText(/beta find-token in the second hit/)).toBeTruthy();
    expect(screen.queryByText(/alpha find-token/)).toBeNull();
  });

  it('a late success from the previous page cannot refetch or drop the selected page', async () => {
    const itemA = msg('m-a', 'user', 4, 'alpha find-token in the first hit');
    const itemB = msg('m-b', 'user', 8, 'beta find-token in the second hit');
    const { calls, releases, onLoad, PagedLocate } = pagedLocateFixture(
      itemA,
      itemB,
      hostMatch('occ-a', 'doc-a', itemA, 'find-token'),
      hostMatch('occ-b', 'doc-b', itemB, 'find-token'),
    );
    render(<PagedLocate />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'find-token');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));

    await act(async () => {
      releases[0]!(true);
      await Promise.resolve();
    });
    expect(countFindCalls(calls, false)).toBe(1);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2');
    expect(screen.getByText(/alpha find-token in the first hit/)).toBeTruthy();
    expect(onLoad.mock.calls.map(call => call[0].turn)).toEqual([itemA.turn, itemB.turn]);

    await act(async () => {
      releases[1]!(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(activeFindMessageId()).toBe(messageIdentity(itemB)));
    await waitFor(() => expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 3'));
    expect(countFindCalls(calls, false)).toBe(2);
    expect(calls.filter(url => url.includes('cursor=fresh-b'))).toHaveLength(1);
    expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    expect(onLoad.mock.calls.map(call => call[0].turn)).toEqual([itemA.turn, itemB.turn]);
    expect(screen.getByText(/beta find-token in the second hit/)).toBeTruthy();
    expect(screen.queryByText(/alpha find-token/)).toBeNull();
  });

  it('a repeat Next on the only match retires the old load and a failure can still retry', async () => {
    const item = msg('m-old', 'user', 4, 'span.ri-title in history');
    const match = hostMatch('occ-1', 'doc-1', item, 'span.ri-title');
    const calls = findRouter(findPage([match], { total: 1 }));
    const releases: Array<(ok: boolean) => void> = [];
    const onLoad = vi.fn(() => new Promise<boolean>(resolve => { releases.push(resolve); }));
    render(<Harness items={[]} onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'span.ri-title');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    const findsAfterFirst = calls.length;

    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
    await act(async () => {
      releases[0]!(true);
      await Promise.resolve();
    });
    expect(calls.length).toBe(findsAfterFirst);
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');

    await act(async () => {
      releases[1]!(false);
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(findsAfterFirst));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1');
  });

  it('drops a later-page hit that the fresh complete query no longer returns', async () => {
    const itemA = msg('m-a', 'user', 4, 'alpha find-token in the first hit');
    const itemB = msg('m-b', 'user', 8, 'beta find-token in the second hit');
    const matchA = hostMatch('occ-a', 'doc-a', itemA, 'find-token');
    const matchB = hostMatch('occ-b', 'doc-b', itemB, 'find-token');
    const calls: string[] = [];
    let topPages = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (!url.includes('/find')) return Response.json({ error: 'not_found' }, { status: 404 });
      if (url.includes('cursor=page-2')) return Response.json(findPage([matchB], { total: 2 }));
      topPages += 1;
      return Response.json(findPage(
        [matchA],
        topPages === 1 ? { total: 2, cursor: 'page-2' } : { total: 1 },
      ));
    });
    render(<DriftFind items={[itemA, itemB]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'find-token');
    await waitFor(() => expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 2'));
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('2 / 2');
      expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    });

    await user.click(screen.getByTestId('find-drift'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 1');
      expect(activeFindMessageId()).toBe(messageIdentity(itemA));
      expect(countFindCalls(calls, false)).toBe(2);
      expect(findCursors(calls)).toEqual(['page-2']);
    });
    const settled = calls.length;
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(settled);
    expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 1');
    await user.click(screen.getByTestId('conversation-find-next'));
    expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 1');
    expect(activeFindMessageId()).toBe(messageIdentity(itemA));
    expect(calls.length).toBe(settled);
    expect(findCursors(calls)).toEqual(['page-2']);
  });

  it('confirms the selected hit on a fresh page after the old cursor expires', async () => {
    const itemA = msg('m-a', 'user', 4, 'alpha find-token in the first hit');
    const itemB = msg('m-b', 'user', 8, 'beta find-token in the second hit');
    const itemC = msg('m-c', 'user', 12, 'gamma find-token in the third hit');
    const matchA = hostMatch('occ-a', 'doc-a', itemA, 'find-token');
    const matchB = hostMatch('occ-b', 'doc-b', itemB, 'find-token');
    const matchC = hostMatch('occ-c', 'doc-c', itemC, 'find-token');
    const calls: string[] = [];
    let topPages = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (!url.includes('/find')) return Response.json({ error: 'not_found' }, { status: 404 });
      if (url.includes('cursor=old-b')) return Response.json(findPage([matchB], { total: 2 }));
      if (url.includes('cursor=stale-epoch')) {
        return Response.json({ error: { code: 'stale_cursor', message: 'stale' } }, { status: 409 });
      }
      if (url.includes('cursor=fresh-b')) {
        return Response.json(findPage([matchB], { total: 3, cursor: 'fresh-c' }));
      }
      if (url.includes('cursor=fresh-c')) return Response.json(findPage([matchC], { total: 3 }));
      topPages += 1;
      if (topPages === 1) return Response.json(findPage([matchA], { total: 2, cursor: 'old-b' }));
      if (topPages === 2) return Response.json(findPage([matchA], { total: 3, cursor: 'stale-epoch' }));
      return Response.json(findPage([matchA], { total: 3, cursor: 'fresh-b' }));
    });
    render(<DriftFind items={[itemA, itemB, itemC]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'find-token');
    await waitFor(() => expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 2'));
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('2 / 2');
      expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    });

    await user.click(screen.getByTestId('find-drift'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('2 / 3');
      expect(activeFindMessageId()).toBe(messageIdentity(itemB));
      expect(findCursors(calls)).toEqual(['old-b', 'stale-epoch', 'fresh-b']);
      expect(countFindCalls(calls, false)).toBe(3);
    });
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('3 / 3');
      expect(activeFindMessageId()).toBe(messageIdentity(itemC));
    });
    expect(findCursors(calls)).toEqual(['old-b', 'stale-epoch', 'fresh-b', 'fresh-c']);
    expect(countFindCalls(calls, false)).toBe(3);
    const settled = calls.length;
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(settled);
    expect(findCursors(calls)).toEqual(['old-b', 'stale-epoch', 'fresh-b', 'fresh-c']);
    expect(activeFindMessageId()).toBe(messageIdentity(itemC));
  });

  it('keeps scanning an empty partial refresh until this round confirms the anchor', async () => {
    const itemA = msg('m-a', 'user', 4, 'alpha find-token in the first hit');
    const itemB = msg('m-b', 'user', 8, 'beta find-token in the second hit');
    const matchA = hostMatch('occ-a', 'doc-a', itemA, 'find-token');
    const matchB = hostMatch('occ-b', 'doc-b', itemB, 'find-token');
    const calls: string[] = [];
    let topPages = 0;
    let releaseCont: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (!url.includes('/find')) return Response.json({ error: 'not_found' }, { status: 404 });
      if (url.includes('cursor=page-2')) return Response.json(findPage([matchB], { total: 2 }));
      if (url.includes('cursor=cont')) {
        return new Promise<Response>(resolve => { releaseCont = resolve; });
      }
      topPages += 1;
      if (topPages === 1) return Response.json(findPage([matchA], { total: 2, cursor: 'page-2' }));
      return Response.json(findPage([], { total: 2, complete: false, cursor: 'cont' }));
    });
    render(<DriftFind items={[itemA, itemB]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'find-token');
    await waitFor(() => expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 2'));
    await user.click(screen.getByTestId('conversation-find-next'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('2 / 2');
      expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    });
    const scroller = document.querySelector('.main-scroll');
    if (!(scroller instanceof HTMLElement)) throw new Error('missing transcript scope');
    const scrollTop = scroller.scrollTop;
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');

    await user.click(screen.getByTestId('find-drift'));
    await waitFor(() => {
      expect(findCursors(calls)).toEqual(['page-2', 'cont']);
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('0 / 2+');
    });
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(activeFindMessageId()).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(scrollTop);
    expect(countFindCalls(calls, false)).toBe(2);
    expect(screen.getByTestId('conversation-find-count').textContent).not.toBe('0 / 0');

    await act(async () => {
      releaseCont!(new Response(JSON.stringify(findPage([matchB], { total: 1 })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 1');
      expect(activeFindMessageId()).toBe(messageIdentity(itemB));
    });
    expect(screen.queryByText('Partial')).toBeNull();
    expect(findCursors(calls)).toEqual(['page-2', 'cont']);
    expect(countFindCalls(calls, false)).toBe(2);
    const settled = calls.length;
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(settled);
    expect(activeFindMessageId()).toBe(messageIdentity(itemB));
  });

  it('keeps Find off Composer and panel search across later transcript updates', async () => {
    const first = msg('m-1', 'user', 1, 'alpha plan');
    const second = msg('m-2', 'assistant', 2, 'beta plan');
    findRouter(findPage([
      hostMatch('occ-1', 'doc-1', first, 'plan'),
      hostMatch('occ-2', 'doc-2', second, 'plan'),
    ], { total: 2 }));
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const onLoad = vi.fn(() => gate);
    const composer = document.createElement('input');
    composer.setAttribute('aria-label', 'Composer');
    const browserSearch = document.createElement('input');
    browserSearch.setAttribute('aria-label', 'Browser search');
    const filesSearch = document.createElement('input');
    filesSearch.setAttribute('aria-label', 'Files search');
    const terminalSearch = document.createElement('input');
    terminalSearch.setAttribute('aria-label', 'Terminal search');
    document.body.append(composer, browserSearch, filesSearch, terminalSearch);
    const view = render(<Harness items={[]} onLoadMessageContext={onLoad} />);
    const user = userEvent.setup();
    await openFind(user);
    const input = screen.getByPlaceholderText(/Find in conversation/);
    await user.type(input, 'plan');
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    composer.focus();
    composer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(composer);
    release(true);
    view.rerender(<Harness items={[first]} onLoadMessageContext={onLoad} />);
    await actDelay(40);
    view.rerender(<Harness items={[first, second]} onLoadMessageContext={onLoad} />);
    const text = document.querySelector('.main-scroll p')?.firstChild;
    if (text instanceof Text) text.data = `${text.data} updated`;
    await actDelay(50);
    expect(document.activeElement).toBe(composer);

    browserSearch.focus();
    browserSearch.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    view.rerender(<Harness items={[first, second]} onLoadMessageContext={onLoad} />);
    await actDelay(50);
    expect(document.activeElement).toBe(browserSearch);
    filesSearch.focus();
    filesSearch.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    view.rerender(<Harness items={[second, first]} onLoadMessageContext={onLoad} />);
    await actDelay(30);
    expect(document.activeElement).toBe(filesSearch);
    terminalSearch.focus();
    terminalSearch.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const again = document.querySelector('.main-scroll p')?.firstChild;
    if (again instanceof Text) again.data = `${again.data} again`;
    await actDelay(30);
    expect(document.activeElement).toBe(terminalSearch);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2');
    composer.remove();
    browserSearch.remove();
    filesSearch.remove();
    terminalSearch.remove();
  });

  it('Esc still restores the focus Find opened from', async () => {
    const item = msg('m-1', 'user', 1, 'alpha plan');
    findRouter(findPage([hostMatch('occ-1', 'doc-1', item, 'plan')], { total: 1 }));
    render(<Harness items={[item]} />);
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Composer');
    document.querySelector('.main')!.appendChild(composer);
    composer.focus();
    const user = userEvent.setup();
    await openFind(user);
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Find in conversation/));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('highlights a reference-only message whose composer caret space was trimmed', async () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        { type: 'reference', id: 'ref-image', referenceType: 'context', label: 'image1' },
        { type: 'text', text: ' ' },
      ],
    };
    const item = msg('m-1', 'user', 1, '', { composerDocument: document });
    findRouter(findPage([hostMatch('occ-1', 'doc-1', item, 'image')], { total: 1 }));
    render(<Harness items={[item]} />);
    const user = userEvent.setup();
    await openFind(user);
    await user.type(screen.getByPlaceholderText(/Find in conversation/), 'image');
    await screen.findByTestId('conversation-find-count');
    await waitFor(() => {
      const active = highlightRegistry.get('gian-find-active')?.ranges[0];
      expect(active?.toString()).toBe('image');
      expect((active?.startContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
    });
  });
});

async function actDelay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function messageIdentity(item: MsgItem): string {
  return `${item.turn}:${item.kind}:${item.id}`;
}

function countFindCalls(calls: string[], cursor: boolean): number {
  return calls.filter(url => url.includes('/find') && url.includes('cursor=') === cursor).length;
}

function findCursors(calls: string[]): string[] {
  return calls.flatMap(url => {
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
    return cursor ? [cursor] : [];
  });
}

function activeFindMessageId(): string | null {
  const node = highlightRegistry.get('gian-find-active')?.ranges[0]?.startContainer;
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest('[data-transcript-source-id]')?.getAttribute('data-transcript-source-id') ?? null;
}

/** Two real find pages. Resolving a load with true swaps in that hit's window. */
function pagedLocateFixture(itemA: MsgItem, itemB: MsgItem, matchA: FindMatch, matchB: FindMatch) {
  const calls: string[] = [];
  const releases: Array<(ok: boolean) => void> = [];
  const applyItems: { current: (items: MsgItem[]) => void } = { current: () => {} };
  let topPages = 0;
  mockFetch(async input => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (!url.includes('/find')) return Response.json({ error: 'not_found' }, { status: 404 });
    if (url.includes('cursor=page-2')) return Response.json(findPage([matchB], { total: 2 }));
    if (url.includes('cursor=fresh-b')) return Response.json(findPage([matchB], { total: 3 }));
    topPages += 1;
    // The refresh's own later page is what confirms B. The first page of
    // that round still does not contain B.
    return Response.json(findPage(
      [matchA],
      { total: topPages === 1 ? 2 : 3, cursor: topPages === 1 ? 'page-2' : 'fresh-b' },
    ));
  });
  const onLoad = vi.fn((request: { turn?: number }) => new Promise<boolean>(resolve => {
    releases.push(ok => {
      if (ok) applyItems.current(request.turn === itemB.turn ? [itemB] : [itemA]);
      resolve(ok);
    });
  }));
  function PagedLocate() {
    const [items, setItems] = useState<MsgItem[]>([]);
    applyItems.current = setItems;
    const tail = items[items.length - 1];
    const tailText = tail && 'text' in tail ? tail.text.length : 0;
    return (
      <Harness
        items={items}
        contentSignal={`${items.length}:${tailText}`}
        onLoadMessageContext={onLoad}
      />
    );
  }
  return { calls, releases, onLoad, PagedLocate };
}

/** Mutate the transcript and flush the find observer's animation frame. */
async function flushTranscriptDomTick(): Promise<void> {
  const frames: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.push(callback);
    return frames.length;
  });
  try {
    const scope = document.querySelector('.main-scroll');
    if (!(scope instanceof HTMLElement)) throw new Error('missing transcript scope');
    const text = scope.querySelector('p')?.firstChild;
    if (text instanceof Text) text.data = `${text.data} nudged`;
    else {
      const extra = document.createElement('p');
      extra.textContent = 'nudged';
      scope.appendChild(extra);
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(frames.length).toBeGreaterThan(0);
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
  } finally {
    spy.mockRestore();
  }
}
