#!/usr/bin/env node
// Session peer for the stdio regression. The runtime process tests keep using
// fake-antigravity-acp.mjs. This process is started by an absolute execPath
// wrapper and exits when its stdin closes so the proxy can reap it.

import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const nativeOptions = [
  {
    id: 'model',
    name: 'Model',
    description: 'Which model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-2.5-pro',
    options: [
      {
        group: 'anthropic',
        name: 'Anthropic',
        options: [{ value: 'claude-sonnet', name: 'Claude' }],
      },
      {
        group: 'google',
        name: 'Google',
        options: [
          { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'stable' },
          { value: 'Gemini-upper', name: 'Not prefix' },
          { value: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        ],
      },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'plan',
    options: [
      { value: 'plan', name: 'Plan' },
      { value: 'ask', name: 'Ask' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'flag',
    name: 'Flag',
    type: 'boolean',
    currentValue: false,
  },
];

const permissions = new Map();
const turns = new Map();
let sessionSerial = 0;
let permissionSerial = 0;
let exiting = false;

function writeReport(name, value) {
  const path = process.env[name];
  if (typeof path === 'string' && path !== '') writeFileSync(path, value);
}

function logMethod(method) {
  const path = process.env.FAKE_SESSION_LOG;
  if (typeof path === 'string' && path !== '') appendFileSync(path, `${method}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exitSoon() {
  if (exiting) return;
  exiting = true;
  process.exit(0);
}

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  const texts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('');
}

function selectedOption(result) {
  const outcome = result && typeof result === 'object' ? result.outcome : undefined;
  if (!outcome || outcome.outcome !== 'selected' || typeof outcome.optionId !== 'string') return null;
  return outcome.optionId;
}

function sendText(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  });
}

function finishTurn(state, stopReason) {
  if (state.settled) return;
  state.settled = true;
  send({ jsonrpc: '2.0', id: state.requestId, result: { stopReason } });
}

function requestPermission(sessionId) {
  const id = `perm-${++permissionSerial}`;
  logMethod('session/request_permission');
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: `tool-${sessionId}`,
        title: 'Run tool',
        kind: 'execute',
        status: 'pending',
      },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    },
  });
  return new Promise((resolve) => {
    const settle = (result) => {
      permissions.delete(id);
      resolve(result);
    };
    permissions.set(id, settle);
    const state = turns.get(sessionId);
    if (state) {
      state.cancelPermission = () => {
        if (!permissions.has(id)) return;
        settle({ outcome: { outcome: 'cancelled' } });
      };
    }
  });
}

async function handlePrompt(message) {
  const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : '';
  const state = { requestId: message.id, settled: false, cancelPermission: () => undefined };
  turns.set(sessionId, state);
  const text = promptText(message.params);
  if (text === 'need-approval' || text === 'need-cancel') {
    const decision = await requestPermission(sessionId);
    if (state.settled) return;
    if (selectedOption(decision) !== 'allow') {
      finishTurn(state, 'cancelled');
      return;
    }
    sendText(sessionId, 'approved');
    finishTurn(state, 'end_turn');
    return;
  }
  if (text === 'stream-hello') {
    sendText(sessionId, 'hel');
    sendText(sessionId, 'lo');
    finishTurn(state, 'end_turn');
    return;
  }
  sendText(sessionId, 'hello');
  finishTurn(state, 'end_turn');
}

function configAfterSet(params) {
  const configId = typeof params?.configId === 'string' ? params.configId : '';
  const value = typeof params?.value === 'string' ? params.value : '';
  return nativeOptions.map((option) => (
    option.id === configId && option.type === 'select'
      ? { ...option, currentValue: value }
      : option
  ));
}

function handleRequest(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
        ],
        agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.3.0' },
      },
    });
    return;
  }
  if (message.method === 'session/new') {
    sessionSerial += 1;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId: `native-${sessionSerial}`, configOptions: nativeOptions },
    });
    return;
  }
  if (message.method === 'session/set_config_option') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { configOptions: configAfterSet(message.params) },
    });
    return;
  }
  if (message.method === 'session/prompt') {
    void handlePrompt(message);
    return;
  }
  if (message.method === 'session/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessions: [] } });
    return;
  }
  if (message.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not found' },
  });
}

writeReport('FAKE_SESSION_PID', String(process.pid));
writeReport('FAKE_SESSION_REPORT', JSON.stringify({
  HOME: process.env.HOME ?? null,
  PATH: process.env.PATH ?? null,
  execPath: process.execPath,
  script: process.argv[1] ?? null,
  harness: process.env.ANTIGRAVITY_HARNESS_PATH ?? null,
}));

process.on('SIGTERM', exitSoon);
process.on('SIGINT', exitSoon);

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
  if (typeof message.method !== 'string') {
    const settle = permissions.get(message.id);
    if (settle) settle(message.result ?? null);
    return;
  }
  logMethod(message.method);
  if (message.id === undefined) {
    if (message.method === 'session/cancel') {
      const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : '';
      const state = turns.get(sessionId);
      if (!state) return;
      state.cancelPermission();
      finishTurn(state, 'cancelled');
    }
    return;
  }
  handleRequest(message);
});
input.on('close', exitSoon);
