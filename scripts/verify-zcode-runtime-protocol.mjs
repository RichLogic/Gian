import { spawn } from 'node:child_process';

/** No model request or user credentials. Qualify the extracted Runtime's
 * actual catalog boundary, not merely its --version output. Incompatible
 * upstream protocols must block publication of the Proxy/Runtime pair. */
export function verifyZcodeRuntimeProtocol(entryPath, home, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, 'app-server', '--stdio', '--surface', 'desktop'], {
      cwd: workspace,
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: home, LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let outcome;
    let received = 0;
    const pending = new Map([
      ['gian-runtime-model-probe', 'gian/modelCatalog'],
      ['gian-runtime-presentation-probe', 'workspace/readPresentation'],
    ]);
    const stop = error => {
      if (outcome) return;
      outcome = { error };
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(new Error('ZCode app-server catalog probe timed out.')), 20_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => stop(error));
    child.stderr.on('data', () => { /* Drain without exposing runtime diagnostics/credentials. */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      received += Buffer.byteLength(chunk);
      if (received > 4 * 1024 * 1024) return stop(new Error('ZCode catalog probe exceeded its output limit.'));
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { return stop(new Error('ZCode app-server stdout is not a protocol stream.')); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          return stop(new Error('ZCode app-server emitted an invalid protocol envelope.'));
        }
        const method = pending.get(message.id);
        if (!method) continue;
        if (message.error || !message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
          return stop(new Error(`ZCode app-server does not support the pinned ${method} contract.`));
        }
        if (method === 'gian/modelCatalog' && (message.result.schemaVersion !== 1 || !Array.isArray(message.result.models))) {
          return stop(new Error('ZCode model catalog has an incompatible schema.'));
        }
        if (method === 'workspace/readPresentation' && !Array.isArray(message.result.slashCommands)) {
          return stop(new Error('ZCode workspace presentation has an incompatible schema.'));
        }
        pending.delete(message.id);
        if (pending.size === 0) return stop(null);
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!outcome) reject(new Error('ZCode app-server exited before answering its catalog probe.'));
      else if (outcome.error) reject(outcome.error);
      else resolve();
    });
    for (const [id, method] of pending) {
      child.stdin.write(`${JSON.stringify({ id, method, params: method === 'gian/modelCatalog' ? {}
        : { workspace: { workspacePath: workspace, workspaceKey: workspace } } })}\n`);
    }
  });
}
