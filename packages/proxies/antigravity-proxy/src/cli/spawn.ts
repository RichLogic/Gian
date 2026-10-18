#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNdjsonLines } from '@gian/proxy-protocol';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { AntigravityProxyService } from '../core/service.js';
import { AntigravityProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { AntigravityAcpClient } from '../runtime/acp-client.js';
import { discoverAntigravityRuntimes, probeAntigravityRuntime } from '../runtime/discover.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { createProtocolWriter, parseRequestLine, type WireRequest } from '../transport/protocol.js';

const PLUGIN_ID = 'io.gian.antigravity';

function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (value.name === '@gian/antigravity-proxy' && value.version) return value.version;
    } catch { /* The bundled and source entrypoints have different depths. */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Antigravity Proxy package identity is unavailable.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'antigravity-bin': { type: 'string' },
      'self-test': { type: 'boolean' },
      authenticate: { type: 'boolean' },
    },
  });
  const version = packageVersion();
  if (values['self-test']) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 4, id: PLUGIN_ID, pluginVersion: version, ok: true })}\n`);
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    if (values.authenticate) throw new Error('Authentication is not a bootstrap operation.');
    await serveRuntimeBootstrap({
      pluginId: PLUGIN_ID, pluginName: 'Antigravity', pluginVersion: version, processScope: 'shared',
      installPlan: planRuntimeInstallation, discover: discoverAntigravityRuntimes, probe: probeAntigravityRuntime,
    });
    return;
  }
  const binaryPath = values['antigravity-bin'] ?? process.env.GIAN_RUNTIME_BIN ?? process.env.ANTIGRAVITY_BIN;
  if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('An absolute Antigravity ACP server path is required.');
  const runtime = new AntigravityAcpClient({ binaryPath });
  if (values.authenticate) {
    try {
      await runtime.ensureStarted();
      await runtime.authenticate({ methodId: 'oauth-personal' });
      process.stdout.write(`${JSON.stringify({ ok: true, authentication: 'oauth-personal' })}\n`);
    } finally { await runtime.stop(); }
    return;
  }
  const service = new AntigravityProxyService({ runtime });
  const writer = createProtocolWriter(process.stdout);
  const adapter = new AntigravityProtocolV2Adapter(service, version, writer.notification);
  const pending = new Set<Promise<void>>();
  const queues = new Map<string, Promise<void>>();
  const overtake = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= adapter.close();
    return closing;
  };
  const terminate = (code: number) => { void close().then(() => process.exit(code), () => process.exit(1)); };
  const onSignal = () => { terminate(0); };
  const onFatal = () => {
    process.stderr.write('Antigravity Proxy failed; retiring its owned runtime.\n');
    terminate(1);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onFatal);

  const dispatch = (request: WireRequest): Promise<void> => adapter.dispatch(request, (result, error) => {
    if (error !== undefined) writer.error(request.id, error);
    else writer.result(request.id, result);
  });
  try {
    for await (const line of readNdjsonLines(process.stdin)) {
      if (!line.trim()) continue;
      let request: WireRequest;
      try { request = parseRequestLine(line); }
      catch (error) {
        let id: string | null = null;
        try { const parsed = JSON.parse(line) as { id?: unknown }; if (typeof parsed?.id === 'string') id = parsed.id; } catch { /* Parse errors have a null id. */ }
        writer.error(id, error);
        continue;
      }
      if (request.method === 'initialize' || request.method === 'shutdown') {
        await dispatch(request);
        if (request.method === 'shutdown') break;
        continue;
      }
      const key = typeof request.params.sessionId === 'string' ? request.params.sessionId : '';
      const previous = queues.get(key) ?? Promise.resolve();
      const operation = (overtake.has(request.method) ? Promise.resolve() : previous)
        .then(() => dispatch(request));
      const settled = operation.catch(() => { process.exitCode = 1; void close(); });
      pending.add(settled);
      if (!overtake.has(request.method)) queues.set(key, settled);
      void settled.then(() => {
        pending.delete(settled);
        if (queues.get(key) === settled) queues.delete(key);
      });
    }
  } finally {
    let closeError: unknown;
    try {
      await close();
    } catch (error) {
      closeError = error;
    }
    try {
      await Promise.allSettled(pending);
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('uncaughtException', onFatal);
      process.removeListener('unhandledRejection', onFatal);
    }
    if (closeError !== undefined) throw closeError;
  }
}

main().catch(() => {
  // Native diagnostics can contain OAuth material. The structured normal
  // request path reports redacted errors; startup failures stay generic.
  process.stderr.write('Antigravity Proxy startup or transport failed.\n');
  process.exitCode = 1;
});
