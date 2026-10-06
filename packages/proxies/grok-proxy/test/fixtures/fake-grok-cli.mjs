#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';

// GROK_TEST_EXT_METHODS=none simulates the published 1.0.41 stdio binary: the
// _meta advertises grokShell and a modern agentVersion, but NO x.ai/* request
// method is registered (every one answers -32601 "Method not found"). The
// default registers the full extension surface.
const EXT_METHODS_REGISTERED = process.env.GROK_TEST_EXT_METHODS !== 'none';

function extDispatch(method, handle) {
  if (!EXT_METHODS_REGISTERED) {
    throw RequestError.methodNotFound(method);
  }
  return handle();
}

if (process.env.GROK_TEST_SPAWN_RECORD) {
  await writeFile(process.env.GROK_TEST_SPAWN_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    disableAutoUpdater: process.env.GROK_DISABLE_AUTOUPDATER,
    sandbox: process.env.GROK_SANDBOX,
  }));
}

const FORKED_SESSION_ID = 'native-forked-child';
const knownSessions = new Set(['native-new', 'native-existing', FORKED_SESSION_ID]);

function rememberSession(sessionId) {
  if (typeof sessionId === 'string' && sessionId) knownSessions.add(sessionId);
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((agentConn) => ({
  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: 'fake-grok', version: '1.0.41-test' },
      _meta: {
        grokShell: true,
        agentVersion: '1.0.41',
        modelState: {
          currentModelId: 'grok-4.6',
          availableModels: [{
            modelId: 'grok-4.6',
            name: 'Grok 4.6',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'xhigh',
              reasoningEfforts: [
                { id: 'xhigh', value: 'xhigh', label: 'Extra High', default: true },
                { id: 'high', value: 'high', label: 'High', default: false },
              ],
            },
          }],
        },
        availableCommands: [
          { name: 'compact', description: 'Compress history' },
          { name: 'fork', description: 'Fork' },
          { name: 'always-approve', description: 'Toggle always-approve' },
        ],
      },
    };
  },
  async newSession() {
    rememberSession('native-new');
    return { sessionId: 'native-new' };
  },
  async listSessions() {
    return { sessions: [{ sessionId: 'native-existing', cwd: process.cwd(), title: 'Existing' }] };
  },
  async loadSession({ sessionId }) {
    rememberSession(sessionId);
    return { sessionId };
  },
  async resumeSession({ sessionId }) {
    rememberSession(sessionId);
    return { sessionId };
  },
  async closeSession() {
    return {};
  },
  extMethod: async (method, params) => {
    // Bare x.ai/* is not the wire form. The Proxy must send _x.ai/*.
    if (typeof method !== 'string' || !method.startsWith('_x.ai/')) {
      throw RequestError.methodNotFound(String(method));
    }
    const logical = method.slice(1);
    const record = params && typeof params === 'object' ? params : {};
    return extDispatch(logical, () => {
      if (logical === 'x.ai/session/delete') {
        return { success: true };
      }
      if (logical === 'x.ai/session/rename') {
        return { success: true, title: record.title ?? '' };
      }
      if (logical === 'x.ai/session/fork') {
        rememberSession(FORKED_SESSION_ID);
        return {
          newSessionId: FORKED_SESSION_ID,
          chatMessagesCopied: 3,
          updatesCopied: 5,
          planStateCopied: false,
          newCwd: process.cwd(),
          parentSessionId: record.sourceSessionId ?? 'native-new',
        };
      }
      if (logical === 'x.ai/interject') {
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
        if (!knownSessions.has(sessionId)) {
          throw RequestError.invalidParams(`session not found: ${sessionId}`);
        }
        return { result: { status: 'queued' } };
      }
      if (logical === 'x.ai/mcp/list') {
        return { servers: [], sessionMcpResolved: true };
      }
      if (logical === 'x.ai/skills/list') {
        return { skills: [] };
      }
      if (logical === 'x.ai/hooks/list') {
        return { hooks: [] };
      }
      if (logical === 'x.ai/session/usage') {
        return { usage: {} };
      }
      if (logical === 'x.ai/session/update_mcp_servers') {
        return { ok: true };
      }
      throw RequestError.methodNotFound(method);
    });
  },
  extNotification: async (method) => {
    if (typeof method !== 'string' || !method.startsWith('_x.ai/')) {
      throw RequestError.methodNotFound(String(method));
    }
  },
  async prompt() {
    await agentConn.sessionUpdate({
      sessionId: 'native-new',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'pong' },
      },
    });
    return { stopReason: 'end_turn' };
  },
}), stream);
