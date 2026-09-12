import { describe, expect, it } from 'vitest';
import type { RemoteTranscriptItem } from '@gian/remote-protocol';
import { generateCanonicalId } from '@gian/remote-protocol';

import {
  applyCanonicalEvent,
  applyRemoteTranscriptItem,
  applyTranscriptPage,
} from '../src/controller/apply-control.js';
import { createFixtureController } from '../src/controller/fixture.js';

function common(id = generateCanonicalId()) {
  return {
    id,
    turn_id: generateCanonicalId(),
    turn: 7,
    ts: 1_789_000_000_000,
  };
}

describe('Remote transcript projection', () => {
  it('keeps one real turn and merges streaming updates by logical event identity', () => {
    const assistantId = generateCanonicalId();
    const commandId = generateCanonicalId();
    const turnId = generateCanonicalId();
    const items: RemoteTranscriptItem[] = [
      { ...common(), kind: 'user', text: 'Please inspect this.' },
      { ...common(assistantId), turn_id: turnId, kind: 'assistant', text: 'Working ', delta: true },
      { ...common(assistantId), turn_id: turnId, kind: 'assistant', text: 'on it.', delta: true },
      { ...common(commandId), turn_id: turnId, kind: 'command', status: 'running' },
      { ...common(commandId), turn_id: turnId, kind: 'command', status: 'success', exit_code: 0 },
      { ...common(), turn_id: turnId, kind: 'turn-end', outcome: 'worked' },
    ];

    const state = createFixtureController().state;
    const next = applyTranscriptPage(state, 's-1', items, 'codex', true);
    const transcript = next.transcripts['s-1']!;

    expect(transcript.hasOlder).toBe(true);
    expect(transcript.streaming).toBe(true);
    expect(transcript.items.every((item) => item.turn === 7)).toBe(true);
    expect(transcript.items.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(transcript.items.find((item) => item.kind === 'assistant')).toMatchObject({
      text: 'Working on it.',
      exec: 'codex',
    });
    expect(transcript.items.filter((item) => item.kind === 'command')).toHaveLength(1);
    expect(transcript.items.find((item) => item.kind === 'command')).toMatchObject({
      status: 'success',
      exitCode: 0,
    });
  });

  it('stops the running transcript state on terminal event or Session update', () => {
    const controller = createFixtureController();
    const state = applyTranscriptPage(controller.state, 's-1', [], 'codex', false);
    const terminal = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: {
        kind: 'transcript.item',
        session_id: 's-1',
        item: { ...common(), kind: 'turn-end', outcome: 'worked' },
      },
    });
    expect(terminal.transcripts['s-1']!.streaming).toBe(false);

    const session = terminal.sessions.find((entry) => entry.id === 's-1')!;
    const updated = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 1,
      event: { kind: 'session.updated', session: { ...session, status: 'done' } },
    });
    expect(updated.transcripts['s-1']!.streaming).toBe(false);
  });

  it('uses the selected Session executor for live deltas and does not invent notice rows', () => {
    const controller = createFixtureController();
    const state = applyTranscriptPage(controller.state, 's-1', [], 'codex', false);
    const item: RemoteTranscriptItem = {
      ...common(),
      kind: 'assistant',
      text: 'Hello',
      delta: true,
    };
    const next = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: { kind: 'transcript.item', session_id: 's-1', item },
    });

    expect(next.transcripts['s-1']!.items).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello', exec: 'codex', turn: 7 }),
    ]);
    expect(next.transcripts['s-1']!.items.some((entry) => entry.kind === 'auto-notice')).toBe(false);
  });

  it('maps historical attachment metadata without inventing a Host URL', () => {
    const attachmentId = generateCanonicalId();
    const next = applyRemoteTranscriptItem([], {
      ...common(),
      kind: 'user',
      text: 'see file',
      attachments: [{
        id: attachmentId,
        session_id: generateCanonicalId(),
        name: 'notes.md',
        mime: 'text/markdown',
        size: 42,
        revision: 'event:0',
        previewable: true,
        downloadable: true,
        expires_at: new Date().toISOString(),
      }],
    }, 'codex');

    expect(next[0]).toMatchObject({
      kind: 'user',
      attachments: [{ name: 'notes.md', mime: 'text/markdown', url: attachmentId, size: 42 }],
    });
  });

  it('drops a legacy or malformed runtime row instead of fabricating Turn Failed', () => {
    const before = [{
      kind: 'user' as const,
      id: generateCanonicalId(),
      text: 'kept',
      exec: 'codex',
      ts: 1,
      turn: 1,
    }];
    const legacy = {
      id: generateCanonicalId(),
      turn_id: generateCanonicalId(),
      category: 'notice',
      text: 'notice',
    } as unknown as RemoteTranscriptItem;

    expect(applyRemoteTranscriptItem(before, legacy, 'codex')).toBe(before);
  });
});
