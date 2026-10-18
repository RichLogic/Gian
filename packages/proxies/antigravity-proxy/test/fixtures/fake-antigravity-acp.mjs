#!/usr/bin/env node
// Tests exec this file with an absolute process.execPath. The .par/.exe entry is a shell wrapper.
import { spawn } from 'node:child_process';
import { accessSync, appendFileSync, constants, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const orphan = env.FAKE_AGY_ORPHAN === '1';
const stubborn = env.FAKE_AGY_STUBBORN === '1';
const holdPrompt = env.FAKE_AGY_HOLD_PROMPT === '1';
const heldPrompts = [];

const DESCENDANT = [
  'process.on("SIGHUP",()=>{});',
  'process.on("SIGTERM",()=>{});',
  'process.on("SIGINT",()=>{});',
  'setInterval(()=>{},1000);',
].join('');

function writeReport(name, value) {
  const path = env[name];
  if (typeof path === 'string' && path !== '') writeFileSync(path, value);
}

function logMethod(method) {
  if (typeof env.FAKE_AGY_LOG === 'string' && env.FAKE_AGY_LOG !== '') {
    appendFileSync(env.FAKE_AGY_LOG, `${method}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function spawnDescendant() {
  const child = spawn(process.execPath, ['-e', DESCENDANT], { stdio: 'ignore' });
  if (child.pid !== undefined) writeReport('FAKE_AGY_DESCENDANT_PID', String(child.pid));
  return child;
}

writeReport('FAKE_AGY_PID', String(process.pid));

if (env.FAKE_AGY_REQUIRE_HARNESS === '1') {
  const harness = env.ANTIGRAVITY_HARNESS_PATH ?? '';
  try {
    accessSync(harness, constants.X_OK);
  } catch {
    process.stderr.write('missing harness\n');
    process.exit(2);
  }
}

if (stubborn) {
  process.on('SIGTERM', () => undefined);
  process.on('SIGHUP', () => undefined);
  spawnDescendant();
  setInterval(() => undefined, 1000);
}

const capabilities = {
  loadSession: env.FAKE_AGY_NO_LOAD === '1' ? false : true,
  sessionCapabilities: {
    list: env.FAKE_AGY_NO_LIST === '1' ? null : {},
    resume: env.FAKE_AGY_NO_RESUME === '1' ? null : {},
  },
  auth: { logout: {} },
};

const authMethods = [
  { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
  { id: 'oauth-business', name: 'Log in with Gemini Enterprise', description: 'Log in with your Gemini Enterprise account' },
  { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' },
  { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform', description: 'Use Gemini Enterprise Agent Platform' },
];

function releaseHeld(stopReason) {
  const pending = heldPrompts.splice(0);
  for (const message of pending) {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason } });
  }
}

function handle(message) {
  if (typeof message.method === 'string') logMethod(message.method);
  if (message.method === 'session/cancel') {
    releaseHeld('cancelled');
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    writeReport('FAKE_AGY_INIT_REPORT', JSON.stringify(message.params ?? null));
    writeReport('FAKE_AGY_ENV_REPORT', JSON.stringify({
      HOME: env.HOME ?? null,
      GEMINI_HOME: env.GEMINI_HOME ?? null,
      GIAN_AGENT_HOME: env.GIAN_AGENT_HOME ?? null,
      ANTIGRAVITY_HARNESS_PATH: env.ANTIGRAVITY_HARNESS_PATH ?? null,
      argv: process.argv,
    }));
    if (env.FAKE_AGY_IGNORE_INITIALIZE === '1') return;
    if (orphan) spawnDescendant();
    const agentName = env.FAKE_AGY_AGENT_NAME ?? 'antigravity-acp';
    const agentVersion = env.FAKE_AGY_VERSION ?? '1.3.0';
    writeReport('FAKE_AGY_AGENT_REPORT', JSON.stringify({ name: agentName, version: agentVersion }));
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: Number(env.FAKE_AGY_PROTOCOL_VERSION ?? 1),
        agentCapabilities: capabilities,
        authMethods,
        agentInfo: {
          name: agentName,
          title: 'Google Antigravity',
          version: agentVersion,
        },
      },
    });
    if (orphan) setTimeout(() => process.exit(0), 50);
    return;
  }
  if (message.method === 'session/close') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (message.method === 'session/prompt' && holdPrompt) {
    heldPrompts.push(message);
    return;
  }
  if (message.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
    return;
  }
  if (message.method === 'session/load' || message.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessions: [] } });
    return;
  }
  if (message.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } });
    return;
  }
  if (message.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: message.params?.sessionId ?? 'fake-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(message);
});

process.stderr.write('fake-antigravity-acp ready\n');
