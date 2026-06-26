// Coverage for PRD-v3 P4 — the subtask-completion summarizer (`.ai/` write-back).
//
// Exercises the pure fs mechanics against a real temp workspace:
//   • C1: STATE.md / HANDOFF.md are backed up to `.ai/.history/` before overwrite
//   • SESSION_LOG.md append format (timestamp + subtask ref) on completion
//   • template fallback output shape (mentions subtask name + status)
//   • abandon path appends ONE `abandoned:` line and does NOT touch HANDOFF/STATE
//   • generateSummary uses an injected live LLM, and degrades to template on throw
//
// No DB / live daemon — the live LLM call is TODO(P4-live); these assert the
// deterministic surface around it.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAiDir } from '../src/workspace/index.js';
import {
  applyCompletionWriteback,
  applyAbandonWriteback,
  buildTemplateSummary,
  backupToHistory,
  formatSessionLogEntry,
  formatAbandonLogEntry,
  generateSummary,
  summarizeCompletedSubtask,
  type SubtaskContext,
  type SummaryOutput,
} from '../src/task/summarizer.js';

function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'gian-p4-summarizer-'));
  scaffoldAiDir(ws); // gives us the real `.ai/` scaffold to write back over
  return ws;
}

const SUBTASK: SubtaskContext = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Wire the login form',
  status: 'done',
};

function read(ws: string, rel: string): string {
  return readFileSync(join(ws, rel), 'utf8');
}

test('P4: backupToHistory copies an existing file under .ai/.history with a stamped name', () => {
  const ws = makeWs();
  try {
    const dest = backupToHistory(ws, '.ai/STATE.md', '2026-06-23T00-00-00-000Z');
    assert.ok(dest, 'backup path returned');
    assert.ok(existsSync(dest!), 'backup file exists');
    assert.match(dest!, /\.ai\/\.history\/2026-06-23T00-00-00-000Z-STATE\.md$/, 'stamped name');
    // Content matches the original.
    assert.equal(readFileSync(dest!, 'utf8'), read(ws, '.ai/STATE.md'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P4: backupToHistory is a no-op (null) when the source is absent', () => {
  const ws = makeWs();
  try {
    const dest = backupToHistory(ws, '.ai/DOES_NOT_EXIST.md');
    assert.equal(dest, null, 'nothing to back up → null');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P4: completion writeback backs up STATE+HANDOFF before overwriting, then appends SESSION_LOG', () => {
  const ws = makeWs();
  try {
    // Simulate a hand-edited STATE/HANDOFF that must NOT be silently clobbered.
    const userState = '# State\n\nUSER EDIT — do not lose me.\n';
    const userHandoff = '# Handoff\n\nUSER HANDOFF — keep a copy.\n';
    writeFileSync(join(ws, '.ai/STATE.md'), userState, 'utf8');
    writeFileSync(join(ws, '.ai/HANDOFF.md'), userHandoff, 'utf8');

    const output: SummaryOutput = {
      state: '# State\n\nFresh snapshot.',
      handoff: '# Handoff\n\nDo X next.',
      summary: 'Did the thing.',
      fallback: false,
    };
    const result = applyCompletionWriteback(ws, SUBTASK, output, new Date('2026-06-23T12:00:00.000Z'));

    // C1: both prior files were backed up.
    assert.equal(result.backups.length, 2, 'STATE + HANDOFF backed up');
    const history = readdirSync(join(ws, '.ai/.history'));
    const backedState = history.find(f => f.endsWith('-STATE.md'));
    const backedHandoff = history.find(f => f.endsWith('-HANDOFF.md'));
    assert.ok(backedState && backedHandoff, 'both backups present');
    assert.equal(readFileSync(join(ws, '.ai/.history', backedState!), 'utf8'), userState, 'STATE backup is the user edit');
    assert.equal(readFileSync(join(ws, '.ai/.history', backedHandoff!), 'utf8'), userHandoff, 'HANDOFF backup is the user edit');

    // New bodies written (trailing newline ensured).
    assert.equal(read(ws, '.ai/STATE.md'), '# State\n\nFresh snapshot.\n');
    assert.equal(read(ws, '.ai/HANDOFF.md'), '# Handoff\n\nDo X next.\n');

    // SESSION_LOG got the completion entry.
    const log = read(ws, '.ai/SESSION_LOG.md');
    assert.match(log, /2026-06-23T12:00:00\.000Z — Wire the login form/, 'timestamped subtask ref');
    assert.match(log, new RegExp(`\\[${SUBTASK.id}\\]`), 'subtask id referenced');
    assert.match(log, /status: done/, 'records terminal status');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P4: template fallback mentions the subtask name + status and preserves prior state', () => {
  const out = buildTemplateSummary({
    subtask: SUBTASK,
    currentState: '# State\n\nold snapshot body',
    currentHandoff: '# Handoff\n\nold handoff',
    now: new Date('2026-06-23T12:00:00.000Z'),
  });
  assert.equal(out.fallback, true, 'flagged as fallback');
  assert.match(out.summary, /Wire the login form/, 'summary names the subtask');
  assert.match(out.summary, /done/, 'summary states status');
  assert.match(out.state, /Wire the login form/, 'STATE mentions the subtask');
  assert.match(out.state, /old snapshot body/, 'prior STATE body preserved, not blanked');
  assert.match(out.handoff, /template fallback/i, 'HANDOFF signals it is a fallback');
});

test('P4: abandon writeback appends ONE abandoned line and touches NEITHER HANDOFF NOR STATE', () => {
  const ws = makeWs();
  try {
    const stateBefore = read(ws, '.ai/STATE.md');
    const handoffBefore = read(ws, '.ai/HANDOFF.md');
    const abandoned: SubtaskContext = { ...SUBTASK, status: 'abandoned' };

    applyAbandonWriteback(ws, abandoned, 'scope changed', new Date('2026-06-23T12:00:00.000Z'));

    // STATE + HANDOFF are byte-identical (no rewrite, no backup churn).
    assert.equal(read(ws, '.ai/STATE.md'), stateBefore, 'STATE untouched');
    assert.equal(read(ws, '.ai/HANDOFF.md'), handoffBefore, 'HANDOFF untouched');
    assert.ok(!existsSync(join(ws, '.ai/.history')), 'no .history created on abandon');

    const log = read(ws, '.ai/SESSION_LOG.md');
    assert.match(log, /abandoned: scope changed/, 'abandon reason logged');
    // Exactly one abandoned: line.
    const lines = log.split('\n').filter(l => l.startsWith('abandoned:'));
    assert.equal(lines.length, 1, 'exactly one abandoned line');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P4: abandon with no reason logs a placeholder', () => {
  const entry = formatAbandonLogEntry(SUBTASK, null, new Date('2026-06-23T12:00:00.000Z'));
  assert.match(entry, /abandoned: \(no reason given\)/, 'placeholder when reason omitted');
});

test('P4: formatSessionLogEntry is a fenced block with timestamp + id + status', () => {
  const entry = formatSessionLogEntry(SUBTASK, new Date('2026-06-23T12:00:00.000Z'));
  assert.match(entry, /^\n## 2026-06-23T12:00:00\.000Z — Wire the login form \[11111111/, 'header line');
  assert.match(entry, /\nstatus: done\n/, 'status line');
});

test('P4: generateSummary uses an injected live LLM when it succeeds', async () => {
  const out = await generateSummary({
    subtask: SUBTASK,
    currentState: 'old',
    currentHandoff: 'old',
    llm: async () => ({ state: 'LIVE STATE', handoff: 'LIVE HANDOFF', summary: 'live summary' }),
  });
  assert.equal(out.fallback, false, 'not a fallback when live succeeds');
  assert.equal(out.state, 'LIVE STATE');
  assert.equal(out.handoff, 'LIVE HANDOFF');
  assert.equal(out.summary, 'live summary');
});

test('P4: generateSummary degrades to the template when the live LLM throws', async () => {
  const out = await generateSummary({
    subtask: SUBTASK,
    currentState: 'old state',
    currentHandoff: 'old handoff',
    llm: async () => { throw new Error('rate limited'); },
  });
  assert.equal(out.fallback, true, 'fell back to template on throw');
  assert.match(out.summary, /Wire the login form/, 'template summary names the subtask');
});

test('P4: summarizeCompletedSubtask reads disk + writes back end-to-end (template path)', async () => {
  const ws = makeWs();
  try {
    writeFileSync(join(ws, '.ai/STATE.md'), '# State\n\nseed state\n', 'utf8');
    const result = await summarizeCompletedSubtask({ workspaceDir: ws, subtask: SUBTASK });
    assert.equal(result.fallback, true, 'no llm injected → template');
    assert.equal(result.backups.length, 2, 'backed up STATE + HANDOFF');
    assert.match(result.summary, /Wire the login form/, 'summary returned for sessions.summary');
    // STATE rewritten but prior body preserved inside it.
    assert.match(read(ws, '.ai/STATE.md'), /seed state/, 'prior state body preserved in new snapshot');
    assert.match(read(ws, '.ai/SESSION_LOG.md'), /status: done/, 'session log appended');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Guard: untitled subtask still produces a stable label (id-derived).
test('P4: untitled subtask gets an id-derived label in the log', () => {
  const untitled: SubtaskContext = { id: 'abcdef0123456789', name: null, status: 'done' };
  const entry = formatSessionLogEntry(untitled, new Date('2026-06-23T12:00:00.000Z'));
  assert.match(entry, /\(untitled abcdef01\)/, 'falls back to id-prefix label');
});
