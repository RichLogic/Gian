// Smoke test for the Web test harness. Not tied to any matrix row —
// this exists so a future regression in vitest config / setup.ts shows
// up immediately rather than masking a real failure.

import { describe, it, expect } from 'vitest';
import { MockWebSocket, resetMockWebSockets } from './setup.ts';

describe('web test harness', () => {
  it('jsdom provides a working document', () => {
    document.body.innerHTML = '<div id="probe">hello</div>';
    expect(document.getElementById('probe')?.textContent).toBe('hello');
  });

  it('matchMedia / ResizeObserver / IntersectionObserver are stubbed', () => {
    expect(typeof window.matchMedia).toBe('function');
    expect(typeof globalThis.ResizeObserver).toBe('function');
    expect(typeof globalThis.IntersectionObserver).toBe('function');
  });

  it('MockWebSocket captures sends and drives fake open/message/close', () => {
    resetMockWebSockets();
    const ws = new WebSocket('ws://test/ws') as unknown as MockWebSocket;
    let received: string | null = null;
    ws.onmessage = (ev) => { received = String((ev as MessageEvent).data); };
    let openFired = false;
    ws.onopen = () => { openFired = true; };

    ws.fakeOpen();
    expect(openFired).toBe(true);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    ws.send(JSON.stringify({ type: 'ping' }));
    expect(ws.parsedSent()).toEqual([{ type: 'ping' }]);

    ws.fakeMessage({ type: 'pong' });
    expect(received).toBe(JSON.stringify({ type: 'pong' }));

    ws.close();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
