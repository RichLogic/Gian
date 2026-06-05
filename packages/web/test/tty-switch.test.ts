// Regression for the post-force-recover "can't send" bug.
//
// The Beta surface stages a first message and fires a single `switch-runtime`,
// flushing the message once the host confirms `runtime_mode='tty'`. The bug:
// when that confirmation never arrived (session wedged → user force-recovered,
// or a manual switch back to Chat), the in-flight flag leaked. The next Beta
// send saw "switch already in flight", suppressed the switch-runtime, and the
// message was stashed forever while the composer stayed disabled — identical to
// the symptom on a fresh conversation. PendingTtySwitch.clear() on recover /
// structured / error is the fix.

import { describe, it, expect } from 'vitest';
import { PendingTtySwitch } from '../src/tty-switch.js';

describe('PendingTtySwitch: stage + flush happy path', () => {
  it('first stage requests a switch and flushes the staged text on tty', () => {
    const s = new PendingTtySwitch();
    expect(s.stage('sess', 'hello').sendSwitch).toBe(true);
    expect(s.onTty('sess')).toEqual({ flush: 'hello' });
    // flushed exactly once
    expect(s.onTty('sess')).toEqual({ flush: null });
  });

  it('a second stage while a switch is in flight does NOT double-switch but keeps the latest text', () => {
    const s = new PendingTtySwitch();
    expect(s.stage('sess', 'first').sendSwitch).toBe(true);
    expect(s.stage('sess', 'second').sendSwitch).toBe(false);
    expect(s.onTty('sess')).toEqual({ flush: 'second' });
  });

  it('a switch with nothing staged flushes null', () => {
    const s = new PendingTtySwitch();
    expect(s.stage('sess', null).sendSwitch).toBe(true);
    expect(s.onTty('sess')).toEqual({ flush: null });
  });
});

describe('PendingTtySwitch: clear() unwedges a leaked in-flight switch (force-recover bug)', () => {
  it('after clear(), a subsequent stage re-requests the switch instead of suppressing it', () => {
    const s = new PendingTtySwitch();
    // A switch was requested but tty never confirmed (the session wedged).
    expect(s.stage('sess', 'msg-1').sendSwitch).toBe(true);
    expect(s.isSwitching('sess')).toBe(true);

    // Force-recover clears the bookkeeping.
    s.clear('sess');
    expect(s.isSwitching('sess')).toBe(false);

    // The next Beta send must re-initiate the switch — this is exactly what
    // was broken before: it used to return sendSwitch=false and strand the msg.
    expect(s.stage('sess', 'msg-2').sendSwitch).toBe(true);
    expect(s.onTty('sess')).toEqual({ flush: 'msg-2' });
  });

  it('clear() also drops staged text so a stale message is not flushed later', () => {
    const s = new PendingTtySwitch();
    s.stage('sess', 'stale');
    s.clear('sess');
    // tty comes up later (e.g. a fresh switch) with nothing re-staged
    expect(s.onTty('sess')).toEqual({ flush: null });
  });

  it('clear() is scoped to one session and leaves others untouched', () => {
    const s = new PendingTtySwitch();
    s.stage('a', 'msg-a');
    s.stage('b', 'msg-b');
    s.clear('a');
    expect(s.isSwitching('a')).toBe(false);
    expect(s.isSwitching('b')).toBe(true);
    expect(s.onTty('b')).toEqual({ flush: 'msg-b' });
  });
});
