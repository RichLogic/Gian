// Vitest global setup for `@gian/web`. Loaded by `vitest.config.ts` via
// `setupFiles`. Pin the minimum browser-API mocks the production app
// hits at construction time so individual tests don't have to babysit
// jsdom's missing surface.

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library — tear down any rendered tree after each test
// so the next test sees a clean document.
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Browser API mocks — jsdom doesn't ship these.
// ---------------------------------------------------------------------------

// `matchMedia` is used by some components for prefers-color-scheme.
// Always install (jsdom's omission of it is not announced via `in`).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),    // legacy alias
    removeListener: vi.fn(), // legacy alias
    dispatchEvent: vi.fn(),
  })),
});

// `ResizeObserver` is used by xterm / fit addon / Splitter — without
// this stub, components that mount them throw on construction.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// `IntersectionObserver` shows up in Inspector/Sheet auto-focus logic.
if (!('IntersectionObserver' in globalThis)) {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return []; }
  };
}

// `scrollIntoView` — used by Transcript auto-scroll.
if (typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

// ---------------------------------------------------------------------------
// WebSocket — the App opens one on mount. Without a stub the test
// framework throws on `new WebSocket(...)`. Tests that want to assert on
// send/close behavior can grab the most recent instance via
// `getMockWebSockets()` (re-exported helper below).
// ---------------------------------------------------------------------------

const _instances: MockWebSocket[] = [];

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static lastInstance: MockWebSocket | null = null;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  /** Captured outgoing frames in send-order. JSON strings stay as strings;
   *  callers JSON.parse() when they want the structured form. */
  readonly sent: string[] = [];
  /** Map of event listeners attached via `addEventListener`. */
  readonly listeners: Map<string, Array<(ev: Event) => void>> = new Map();

  onopen: ((this: WebSocket, ev: Event) => void) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => void) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => void) | null = null;
  onerror: ((this: WebSocket, ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
    _instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    const ev = new CloseEvent('close', { code, reason, wasClean: true });
    this.onclose?.call(this as unknown as WebSocket, ev);
    this.emit('close', ev);
  }

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((l) => l !== listener));
  }

  /** Drive a fake `open` event — tests use this to put the socket into
   *  the OPEN state after the App constructed it. */
  fakeOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    const ev = new Event('open');
    this.onopen?.call(this as unknown as WebSocket, ev);
    this.emit('open', ev);
  }

  /** Drive a fake server-sent message. `payload` is either a JSON
   *  string or an object (auto-stringified). */
  fakeMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const ev = new MessageEvent('message', { data });
    this.onmessage?.call(this as unknown as WebSocket, ev);
    this.emit('message', ev);
  }

  private emit(type: string, ev: Event): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }

  /** Parse every JSON frame the client has sent. Throws if any frame
   *  is not valid JSON (helpful: signals an unexpected raw write). */
  parsedSent<T = Record<string, unknown>>(): T[] {
    return this.sent.map((s) => JSON.parse(s) as T);
  }
}

export function getMockWebSockets(): readonly MockWebSocket[] {
  return _instances;
}

export function resetMockWebSockets(): void {
  _instances.length = 0;
  MockWebSocket.lastInstance = null;
}

Object.defineProperty(globalThis, 'WebSocket', {
  writable: true,
  configurable: true,
  value: MockWebSocket,
});

// Reset between tests so a leftover socket from test N doesn't leak
// into N+1's assertions.
afterEach(() => {
  resetMockWebSockets();
});

// ---------------------------------------------------------------------------
// fetch — default to a stub that 404s every request. Tests that need
// specific responses replace it via `vi.spyOn(globalThis, 'fetch')` or
// the `mockFetch` helper below.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch?.bind(globalThis);

export function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(handler as never);
}

if (!globalThis.fetch) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'no fetch handler installed in test' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

afterEach(() => {
  // If a test replaced fetch, restore the default 404 stub.
  if ((globalThis.fetch as { mockRestore?: () => void })?.mockRestore) {
    (globalThis.fetch as { mockRestore: () => void }).mockRestore();
  }
});

void realFetch; // keep reference so a future test can opt back into real fetch
