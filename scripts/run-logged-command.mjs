import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { startProcessResourceMonitor } from './process-resource-monitor.mjs';

export async function runLoggedCommand(command, args, {
  cwd,
  env,
  logPath,
  collectResources = false,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  return await new Promise(resolve => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const monitor = collectResources ? startProcessResourceMonitor(child.pid) : null;

    const forward = (chunk, destination) => {
      appendFileSync(logPath, chunk);
      destination.write(chunk);
    };
    child.stdout.on('data', chunk => forward(chunk, stdout));
    child.stderr.on('data', chunk => forward(chunk, stderr));

    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, resources: monitor?.stop() ?? null });
    };
    child.once('error', error => finish({ error, status: null, signal: null }));
    child.once('close', (status, signal) => finish({ error: null, status, signal }));
  });
}
