import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { openDatabase, type Db } from '../src/storage/db.js';
import { TraceEvidenceStore } from '../src/trace/evidence-store.js';
import { projectTraceSnapshot } from '../src/trace/projector.js';

function notification(
  method: string,
  over: Record<string, unknown> = {},
  sequence = 1,
  emittedAt = '2026-08-10T05:30:00.000Z',
): ProxyNotification {
  return {
    jsonrpc: '2.0',
    method,
    params: {
      eventId: `evt-${method}-${sequence}`,
      streamId: 'stream-1',
      sequence,
      sessionId: 's1',
      turnId: 't1',
      emittedAt,
      data: over,
    },
  } as ProxyNotification;
}

function rawNotification(value: { method: string; params: unknown }): ProxyNotification {
  return { jsonrpc: '2.0', ...value } as ProxyNotification;
}

function seed(db: Db, ...sessionIds: string[]): void {
  db.exec(`
    INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
    VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
  `);
  for (const [index, sessionId] of sessionIds.entries()) {
    db.exec(`
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('${sessionId}','trace','primary','w1','grok','plan','done',0,0,'native-${index}',datetime('now'),datetime('now'));
    `);
  }
}

function withDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gian-trace-evidence-'));
  try {
    const db = openDatabase(dir);
    seed(db, 's1', 's2');
    run(db);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('TRACE: persisted evidence survives a fresh store over the same database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-trace-durable-'));
  try {
    const db = openDatabase(dir);
    seed(db, 's1');
    const store = new TraceEvidenceStore(db);
    store.persist(notification('turn.started', {}, 1));
    store.persist(notification('tool.started', { toolCallId: 'bash-1', name: 'Bash', input: {} }, 2));
    store.persist(notification('tool.completed', { toolCallId: 'bash-1', status: 'succeeded' }, 3));
    store.persist(notification('turn.completed', { stopReason: 'completed' }, 4));
    const before = projectTraceSnapshot('s1', store.listEvidence('s1'), 'GENERATED-1');
    db.close();

    // Reconstruct the service against the same database file.
    const reopened = openDatabase(dir);
    const fresh = new TraceEvidenceStore(reopened);
    const after = projectTraceSnapshot('s1', fresh.listEvidence('s1'), 'GENERATED-2');
    assert.deepEqual(after.items, before.items, 'snapshot semantics survive reconstruction');
    assert.equal(after.partial, false);
    assert.equal(after.sessionId, 's1');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TRACE: repeated eventId is idempotent across live and replay paths', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const started = notification('tool.started', { toolCallId: 'bash-1', name: 'Bash', input: {} }, 2);
    store.persist(started);
    store.persist(started); // live duplicate
    const completed = notification('tool.completed', { toolCallId: 'bash-1', status: 'succeeded' }, 3);
    store.persist(completed);
    store.persist(completed); // replay re-delivery
    const rows = store.listEvidence('s1');
    assert.equal(rows.length, 2, 'duplicates never create extra rows');
    assert.deepEqual(rows.map(row => row.eventId), [started.params.eventId, completed.params.eventId]);
  });
});

test('TRACE: rows are scoped per session and ordered by protocol sequence', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const first = rawNotification({
      method: 'turn.started',
      params: {
        eventId: 'e-1',
        streamId: 'stream-1',
        sequence: 1,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: {},
      },
    });
    const second = rawNotification({
      method: 'turn.completed',
      params: {
        eventId: 'e-2',
        streamId: 'stream-1',
        sequence: 2,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:31:00.000Z',
        data: { stopReason: 'completed' },
      },
    });
    const otherSession = rawNotification({
      method: 'turn.started',
      params: {
        eventId: 'e-3',
        streamId: 'stream-2',
        sequence: 1,
        sessionId: 's2',
        turnId: 't9',
        emittedAt: '2026-08-10T05:32:00.000Z',
        data: {},
      },
    });
    store.persist(second);
    store.persist(otherSession);
    store.persist(first);
    const rows = store.listEvidence('s1');
    assert.deepEqual(rows.map(row => [row.eventId, row.sequence]), [['e-1', 1], ['e-2', 2]]);
    assert.deepEqual(store.listEvidence('s2').map(row => row.eventId), ['e-3']);
    assert.deepEqual(store.listEvidence('missing'), []);
  });
});

test('TRACE: normalization drops uncontrolled output and non-allowlisted events', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const commandDelta = rawNotification({
      method: 'content.delta',
      params: {
        eventId: 'e-cmd',
        streamId: 'stream-1',
        sequence: 1,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: { contentId: 'cmd-1', kind: 'command', delta: 'ls\nfile1\nfile2\n' },
      },
    });
    const toolUpdate = rawNotification({
      method: 'tool.updated',
      params: {
        eventId: 'e-upd',
        streamId: 'stream-1',
        sequence: 2,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:01.000Z',
        data: { toolCallId: 'bash-1', outputDelta: 'huge terminal output', data: { raw: 1 }, statusText: 'running' },
      },
    });
    const toolDone = rawNotification({
      method: 'tool.completed',
      params: {
        eventId: 'e-done',
        streamId: 'stream-1',
        sequence: 3,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:02.000Z',
        data: { toolCallId: 'bash-1', status: 'succeeded', output: 'secret output' },
      },
    });
    const diff = rawNotification({
      method: 'diff.updated',
      params: {
        eventId: 'e-diff',
        streamId: 'stream-1',
        sequence: 4,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:03.000Z',
        data: { diffId: 'd1', diff: '+a\n-b\n'.repeat(500), files: [{ path: 'x.ts', status: 'added' }] },
      },
    });
    const approval = rawNotification({
      method: 'approval.requested',
      params: {
        eventId: 'e-appr',
        streamId: 'stream-1',
        sequence: 5,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:04.000Z',
        data: {
          approvalId: 'a1',
          category: 'command',
          title: 'Run command',
          description: 'cmd',
          options: [{ id: 'allow_once', label: 'Allow once', kind: 'allow_once' }],
          payload: { toolName: 'Bash', inputPreview: 'rm -rf /' },
        },
      },
    });
    const agent = rawNotification({
      method: 'agent.updated',
      params: {
        eventId: 'e-agent',
        streamId: 'stream-1',
        sequence: 6,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:05.000Z',
        data: {
          agentId: 'a-1',
          status: 'completed',
          description: 'Subagent',
          agentType: 'subagent',
          model: 'm1',
          output: 'very long agent output body with secrets',
        },
      },
    });
    store.persist(commandDelta);
    store.persist(toolUpdate);
    store.persist(toolDone);
    store.persist(diff);
    store.persist(approval);
    store.persist(agent);
    const rows = store.listEvidence('s1');
    const byEvent = new Map(rows.map(row => [row.eventId, row]));
    assert.equal(rows.length, 4, 'diff.updated and approval.requested are not allowlisted');
    assert.ok(!byEvent.has('e-diff'), 'diff text must never reach trace_events');
    assert.ok(!byEvent.has('e-appr'), 'approval payload must never reach trace_events');
    assert.deepEqual(byEvent.get('e-cmd')!.data, { contentId: 'cmd-1', kind: 'command' });
    assert.deepEqual(byEvent.get('e-upd')!.data, { toolCallId: 'bash-1', statusText: 'running' });
    assert.deepEqual(byEvent.get('e-done')!.data, { toolCallId: 'bash-1', status: 'succeeded' });
    const agentData = byEvent.get('e-agent')!.data as Record<string, unknown>;
    assert.equal(agentData['output'], undefined, 'agent output body is never stored');
    assert.equal(agentData['outputChars'], 40, 'only output metadata is kept');
    assert.equal(agentData['description'], 'Subagent');
  });
});
test('TRACE: non-allowlisted notifications never write trace_events rows', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const outside: Array<[string, Record<string, unknown>]> = [
      ['diff.updated', { diffId: 'd1', diff: 'x', files: [] }],
      ['approval.requested', {
        approvalId: 'a1',
        category: 'command',
        title: 't',
        description: 'd',
        options: [{ id: 'allow_once', label: 'Allow once', kind: 'allow_once' }],
        payload: {},
      }],
      ['approval.resolved', { approvalId: 'a1', resolution: 'selected', resolvedBy: 'user', optionId: 'allow_once' }],
      ['session.updated', { reason: 'runtime-state-changed', updatedAt: '2026-08-10T05:30:00.000Z' }],
      ['extension.event', { namespace: 'com.example', name: 'n', schemaVersion: 1, payload: {} }],
    ];
    for (const [method, data] of outside) {
      store.persist(rawNotification({
        method,
        params: {
          eventId: `e-${method}`,
          streamId: 'stream-1',
          sequence: 1,
          sessionId: 's1',
          ...(method !== 'session.updated' ? { turnId: 't1' } : {}),
          emittedAt: '2026-08-10T05:30:00.000Z',
          data,
        },
      }));
    }
    assert.deepEqual(store.listEvidence('s1'), [], 'no non-allowlisted method may write rows');
  });
});

test('TRACE: step, request, and usage evidence keeps bounded identity and step linkage', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    store.persist(notification('step.updated', {
      stepId: 'native-turn-1:0', index: 0, status: 'running',
    }, 1));
    store.persist(notification('request.updated', {
      requestId: 'request-1',
      reason: 'initial',
      stepId: 'native-turn-1:0',
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      parameters: { effort: 'high', temperature: 0.2 },
      systemPrompt: { text: 'Use the workspace carefully.', truncated: false },
      tools: [{ name: 'read_file', description: 'Read a file.' }],
      context: { window: 128_000 },
      truncated: false,
    }, 2));
    store.persist(notification('usage.updated', {
      stepId: 'native-turn-1:0',
      conversation: { mode: 'delta', inputTokens: 50, outputTokens: 10 },
    }, 3));
    const rows = store.listEvidence('s1');
    assert.deepEqual(rows.map(row => row.method), [
      'step.updated', 'request.updated', 'usage.updated',
    ]);
    assert.deepEqual(rows[0]!.data, {
      stepId: 'native-turn-1:0', index: 0, status: 'running',
    });
    assert.equal((rows[1]!.data['model'] as Record<string, unknown>)['id'], 'deepseek-chat');
    assert.equal(rows[1]!.data['stepId'], 'native-turn-1:0');
    assert.deepEqual(rows[2]!.data, {
      stepId: 'native-turn-1:0',
      conversation: { mode: 'delta', inputTokens: 50, outputTokens: 10 },
    });
  });
});

test('TRACE: activity evidence preserves safe native timing and redacts details', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const nativeStart = Date.parse('2026-08-10T05:30:01.250Z');
    const nativeEnd = Date.parse('2026-08-10T05:30:03.750Z');
    store.persist(notification('turn.started', {}, 1));
    store.persist(notification('activity.updated', {
      activityId: 'command-1',
      kind: 'command',
      title: 'Command',
      status: 'running',
      presentation: { type: 'command', data: { command: 'git status' } },
      details: {
        timing: { phase: 'started', timestampMs: nativeStart },
        token: 'must-not-survive',
      },
    }, 2));
    store.persist(notification('activity.updated', {
      activityId: 'command-1',
      kind: 'command',
      title: 'Command',
      status: 'succeeded',
      presentation: { type: 'command', data: { command: 'git status' } },
      details: {
        timing: { phase: 'completed', timestampMs: nativeEnd },
        token: 'must-not-survive',
      },
    }, 3));
    store.persist(notification('turn.completed', { stopReason: 'completed' }, 4));

    const activityRows = store.listEvidence('s1').filter(row => row.method === 'activity.updated');
    assert.deepEqual(activityRows.map(row => row.data['timing']), [
      { phase: 'started', timestampMs: nativeStart },
      { phase: 'completed', timestampMs: nativeEnd },
    ]);
    assert.equal(
      ((activityRows[0]!.data['details'] as Record<string, unknown>)['token']),
      '[redacted]',
    );
    const activity = projectTraceSnapshot('s1', store.listEvidence('s1'), 'GENERATED')
      .items.find(item => item.correlationId === 'command-1')!;
    assert.equal(activity.shape, 'span');
    assert.equal(activity.durationMs, 2_500);
  });
});

test('TRACE: nested sensitive keys are redacted recursively', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    store.persist(rawNotification({
      method: 'tool.started',
      params: {
        eventId: 'e-tool-secret',
        streamId: 'stream-1',
        sequence: 2,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: {
          toolCallId: 'bash-1',
          name: 'Bash',
          input: {
            command: 'ls',
            env: {
              PASSWORD: 'hunter2',
              token: 'abc123',
            },
            headers: { authorization: 'Bearer secret-token' },
            config: { apiKey: 'k-1', api_key: 'k-2', accessToken: 'at', refreshToken: 'rt', clientSecret: 'cs' },
            cookies: ['session=xyz'],
            sessionCookie: 'sid',
            nested: { deep: { credential: 'creds', access_token: 'tok' } },
          },
        },
      },
    }));
    const rows = store.listEvidence('s1');
    assert.equal(rows.length, 1);
    const input = (rows[0]!.data as Record<string, unknown>)['input'] as Record<string, unknown>;
    const env = input['env'] as Record<string, unknown>;
    assert.equal(env['PASSWORD'], '[redacted]');
    assert.equal(env['token'], '[redacted]');
    const headers = input['headers'] as Record<string, unknown>;
    assert.equal(headers['authorization'], '[redacted]');
    const config = input['config'] as Record<string, unknown>;
    assert.equal(config['apiKey'], '[redacted]');
    assert.equal(config['api_key'], '[redacted]');
    assert.equal(config['accessToken'], '[redacted]', 'camelCase accessToken is redacted');
    assert.equal(config['refreshToken'], '[redacted]', 'camelCase refreshToken is redacted');
    assert.equal(config['clientSecret'], '[redacted]', 'camelCase clientSecret is redacted');
    // 'cookies' is itself a sensitive key: the whole value is redacted.
    assert.equal(input['cookies'], '[redacted]');
    assert.equal(input['sessionCookie'], '[redacted]', 'camelCase sessionCookie is redacted');
    const nested = input['nested'] as Record<string, unknown>;
    const deep = nested['deep'] as Record<string, unknown>;
    assert.equal(deep['credential'], '[redacted]');
    assert.equal(deep['access_token'], '[redacted]');
    assert.equal(input['command'], 'ls', 'non-sensitive fields survive sanitization');
    const stored = db.prepare('SELECT data FROM trace_events WHERE event_id = ?')
      .get('e-tool-secret') as { data: string };
    assert.ok(!stored.data.includes('hunter2'));
    assert.ok(!stored.data.includes('secret-token'));
  });
});

test('TRACE: oversized strings, arrays, objects, and depth are bounded with markers', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const longText = 'x'.repeat(10_000);
    const bigSteps = Array.from({ length: 100 }, (_, i) => ({ id: `step-${i}`, status: 'pending', text: `step ${i}` }));
    const bigInput: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) bigInput[`field-${i}`] = i;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) {
      cursor['next'] = {};
      cursor = cursor['next'] as Record<string, unknown>;
    }
    store.persist(rawNotification({
      method: 'content.completed',
      params: {
        eventId: 'e-long',
        streamId: 'stream-1',
        sequence: 1,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: { contentId: 'c1', kind: 'text', content: longText },
      },
    }));
    store.persist(rawNotification({
      method: 'plan.updated',
      params: {
        eventId: 'e-steps',
        streamId: 'stream-1',
        sequence: 2,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:01.000Z',
        data: { planId: 'p1', title: 'Plan', steps: bigSteps },
      },
    }));
    store.persist(rawNotification({
      method: 'tool.started',
      params: {
        eventId: 'e-wide',
        streamId: 'stream-1',
        sequence: 3,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:02.000Z',
        data: { toolCallId: 'bash-1', name: 'Bash', input: bigInput },
      },
    }));
    store.persist(rawNotification({
      method: 'tool.started',
      params: {
        eventId: 'e-deep',
        streamId: 'stream-1',
        sequence: 4,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:03.000Z',
        data: { toolCallId: 'deep-1', name: 'Deep', input: deep },
      },
    }));
    const rows = store.listEvidence('s1');
    const byEvent = new Map(rows.map(row => [row.eventId, row]));
    const content = byEvent.get('e-long')!.data as Record<string, unknown>;
    assert.deepEqual(content['content'], { __gian_truncated: true, chars: 10_000 },
      'oversized strings store only a length marker');
    const steps = byEvent.get('e-steps')!.data as { steps: unknown[] };
    assert.equal(steps.steps.length, 33, '32 items + truncation marker');
    assert.deepEqual(steps.steps[32], { __gian_truncated: true, count: 100 });
    const input = byEvent.get('e-wide')!.data as { input: Record<string, unknown> };
    assert.equal(Object.keys(input.input).length, 33, '32 fields + truncation marker');
    assert.deepEqual(input.input['__gian_truncated'], { count: 100 });
    // The 12-level nesting is bounded: the value below depth 6 is a marker.
    const deepInput = byEvent.get('e-deep')!.data as { input: unknown };
    let leaf: unknown = deepInput.input;
    let walked = 0;
    while (leaf && typeof leaf === 'object' && !Array.isArray(leaf)
      && (leaf as Record<string, unknown>)['next'] !== undefined) {
      leaf = (leaf as Record<string, unknown>)['next'];
      walked += 1;
    }
    assert.equal(walked, 6, 'only six object levels survive sanitization');
    assert.deepEqual(leaf, { __gian_truncated: true, depth: 6 },
      'nesting beyond the depth bound is replaced by a marker');
    const stored = db.prepare('SELECT data FROM trace_events WHERE event_id = ?')
      .get('e-long') as { data: string };
    assert.ok(!stored.data.includes('xxxxxxxxxx'), 'truncated content is never stored');
  });
});

test('TRACE: sanitized evidence still projects turn/tool/assistant/plan/agent/notice items', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const events: Array<[string, number, Record<string, unknown>]> = [
      ['turn.started', 1, {}],
      ['input.recorded', 2, { inputId: 'in-1', input: [{ type: 'text', text: 'hello' }] }],
      ['content.delta', 3, { contentId: 'c1', kind: 'text', delta: 'Hel' }],
      ['content.completed', 4, { contentId: 'c1', kind: 'text', content: 'Hello world' }],
      ['tool.started', 5, { toolCallId: 'bash-1', name: 'Bash', input: { command: 'ls' } }],
      ['tool.updated', 6, { toolCallId: 'bash-1', statusText: 'running' }],
      ['tool.completed', 7, { toolCallId: 'bash-1', status: 'succeeded' }],
      ['plan.updated', 8, { planId: 'p1', title: 'Plan A', steps: [{ id: 's1', status: 'completed', text: 'do it' }] }],
      ['agent.updated', 9, { agentId: 'a1', status: 'completed', description: 'Sub' }],
      ['notice.created', 10, { noticeId: 'n1', severity: 'warning', code: 'W', title: 'Heads up', message: 'careful' }],
      ['turn.completed', 11, { stopReason: 'completed' }],
    ];
    for (const [method, sequence, data] of events) {
      store.persist(notification(method, data, sequence,
        new Date(Date.parse('2026-08-10T05:30:00.000Z') + sequence * 1000).toISOString()));
    }
    const snap = projectTraceSnapshot('s1', store.listEvidence('s1'), 'GENERATED');
    assert.equal(snap.partial, false);
    assert.deepEqual(snap.items.map(item => item.kind), [
      'turn', 'input', 'assistant', 'tool', 'plan', 'agent', 'notice',
    ]);
    const byKindMap = new Map(snap.items.map(item => [item.kind, item]));
    assert.equal(byKindMap.get('turn')!.status, 'succeeded');
    assert.equal(byKindMap.get('assistant')!.summary, 'Hello world');
    assert.equal(byKindMap.get('tool')!.status, 'succeeded');
    assert.equal(byKindMap.get('tool')!.durationMs, 2000);
    assert.equal(byKindMap.get('plan')!.summary, '- [x] do it');
    assert.equal(byKindMap.get('agent')!.status, 'succeeded');
    assert.equal(byKindMap.get('notice')!.title, 'Heads up');
  });
});
test('TRACE: byte-cap truncation keeps core identity fields for projection', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    // 32 fields x ~2048 chars survive sanitization and push the payload over
    // the 64 KiB cap — the crop-able input must be folded, identity kept.
    const bigInput: Record<string, unknown> = {};
    for (let i = 0; i < 32; i++) bigInput[`field-${i}`] = 'x'.repeat(2048);
    store.persist(rawNotification({
      method: 'tool.started',
      params: {
        eventId: 'e-big-tool',
        streamId: 'stream-1',
        sequence: 1,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: { toolCallId: 'bash-1', name: 'Bash', title: 'Run ls', input: bigInput },
      },
    }));
    const rows = store.listEvidence('s1');
    assert.equal(rows.length, 1);
    const data = rows[0]!.data as Record<string, unknown>;
    assert.equal(data['toolCallId'], 'bash-1', 'identity survives the byte cap');
    assert.equal(data['name'], 'Bash');
    assert.equal(data['title'], 'Run ls');
    assert.equal(data['input'], undefined, 'crop-able input is folded away');
    const marker = data['__gian_truncated'] as Record<string, unknown>;
    assert.ok(marker && typeof marker['byte_length'] === 'number');
    // The projected tool is not an orphan: it keeps its started identity.
    store.persist(rawNotification({
      method: 'tool.completed',
      params: {
        eventId: 'e-big-done',
        streamId: 'stream-1',
        sequence: 2,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:05.000Z',
        data: { toolCallId: 'bash-1', status: 'succeeded' },
      },
    }));
    store.persist(rawNotification({
      method: 'turn.started',
      params: {
        eventId: 'e-big-turn',
        streamId: 'stream-1',
        sequence: 3,
        sessionId: 's1',
        turnId: 't1',
        emittedAt: '2026-08-10T05:30:00.000Z',
        data: {},
      },
    }));
    const snap = projectTraceSnapshot('s1', store.listEvidence('s1'), 'GENERATED');
    const tool = snap.items.find(item => item.kind === 'tool')!;
    assert.equal(tool.correlationId, 'bash-1');
    assert.equal(tool.status, 'succeeded');
    assert.equal(tool.durationMs, 5000, 'duration still computable after truncation');
  });
});

test('TRACE: stream generations order re-attached streams after older ones', () => {
  withDb(db => {
    const store = new TraceEvidenceStore(db);
    const persist = (eventId: string, method: string, sequence: number,
      streamId: string, turnId: string, emittedAt: string) => {
      store.persist(rawNotification({
        method,
        params: {
          eventId,
          streamId,
          sequence,
          sessionId: 's1',
          turnId,
          emittedAt,
          data: method === 'turn.completed' ? { stopReason: 'completed' } : {},
        },
      }));
    };
    // stream-1: generation 1, sequences 1..3
    persist('e-1', 'turn.started', 1, 'stream-1', 't1', '2026-08-10T05:30:00.000Z');
    persist('e-2', 'turn.completed', 2, 'stream-1', 't1', '2026-08-10T05:30:10.000Z');
    persist('e-3', 'turn.started', 3, 'stream-1', 't2', '2026-08-10T05:30:20.000Z');
    // stream-2 (re-attach): generation 2, sequence resets to 1
    persist('e-4', 'turn.completed', 1, 'stream-2', 't3', '2026-08-10T05:31:00.000Z');
    persist('e-5', 'turn.started', 2, 'stream-2', 't3', '2026-08-10T05:31:10.000Z');
    const rows = store.listEvidence('s1');
    assert.deepEqual(rows.map(row => [row.streamGeneration, row.sequence, row.eventId]), [
      [1, 1, 'e-1'], [1, 2, 'e-2'], [1, 3, 'e-3'],
      [2, 1, 'e-4'], [2, 2, 'e-5'],
    ], 'generation-then-sequence ordering');
    const snap = projectTraceSnapshot('s1', rows, 'GENERATED');
    assert.deepEqual(snap.items.map(item => item.turnId), ['t1', 't2', 't3']);
    // Idempotency keeps the first-seen generation for a stream.
    store.persist(rawNotification({
      method: 'turn.completed',
      params: {
        eventId: 'e-6',
        streamId: 'stream-2',
        sequence: 3,
        sessionId: 's1',
        turnId: 't3',
        emittedAt: '2026-08-10T05:31:20.000Z',
        data: { stopReason: 'completed' },
      },
    }));
    const after = store.listEvidence('s1');
    assert.equal(after[4]!.streamGeneration, 2, 'stream generation is stable across writes');
    // Replaying the same stream-1 events must not bump its generation.
    persist('e-1', 'turn.started', 1, 'stream-1', 't1', '2026-08-10T05:30:00.000Z');
    assert.equal(store.listEvidence('s1').length, 6, 'replay stays idempotent');
  });
});
